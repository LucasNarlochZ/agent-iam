import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeMcpConfiguration } from "../../src/harnesses/claude-mcp.js";
import { claudeHarnessAdapter } from "../../src/harnesses/claude.js";

describe("Claude MCP autowrapping", () => {
    let directory: string;
    let home: string;
    let cwd: string;
    let env: NodeJS.ProcessEnv;
    const github = { command: "github-mcp-server", args: ["stdio"] };
    const proxy = [
        "/runtime/node",
        "/runtime/agentiam.js",
        "mcp",
        "github",
        "--",
    ];

    async function json(path: string, value: unknown) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(value));
    }

    async function discover(args: string[] = []) {
        return claudeMcpConfiguration(env, { cwd, args });
    }

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "agentiam-claude-mcp-"));
        home = join(directory, "home");
        cwd = join(directory, "project");
        await mkdir(home);
        await mkdir(join(cwd, ".git"), { recursive: true });
        env = {
            HOME: home,
            AGENTIAM_NODE: proxy[0],
            AGENTIAM_ENTRYPOINT: proxy[1],
            AGENTIAM_MCP_POLICY_CWD: cwd,
            AGENTIAM_MCP_POLICY_HOME: home,
            AGENTIAM_AUDIT_DIRECTORY: join(directory, "audit"),
        };
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(directory, { recursive: true, force: true });
    });

    it("writes a private overlay without changing source configs or server environment references", async () => {
        const source = join(home, ".claude.json");
        await json(source, {
            mcpServers: {
                github: {
                    ...github,
                    env: {
                        GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}",
                        EXTRA: "preserved",
                    },
                },
            },
        });
        const original = await readFile(source, "utf8");
        await claudeHarnessAdapter.prepare!(
            env,
            directory,
            undefined,
            undefined,
            { cwd, args: ["--print"] },
        );
        expect(await readFile(source, "utf8")).toBe(original);
        const overlay = env.AGENTIAM_CLAUDE_MCP_CONFIG!;
        expect((await stat(overlay)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(overlay, "utf8"))).toEqual({
            mcpServers: {
                github: {
                    command: proxy[0],
                    args: [...proxy.slice(1), github.command, ...github.args],
                    env: {
                        GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}",
                        EXTRA: "preserved",
                        AGENTIAM_MCP_POLICY_CWD: cwd,
                        AGENTIAM_MCP_POLICY_HOME: home,
                        AGENTIAM_AUDIT_DIRECTORY: env.AGENTIAM_AUDIT_DIRECTORY,
                    },
                },
            },
        });
        expect(claudeHarnessAdapter.commandArgs(["--print"], env)).toEqual([
            "--mcp-config",
            overlay,
            "--print",
        ]);
    });

    it("uses settings.env precedence for detection while preserving interpolation for Claude", async () => {
        await json(join(home, ".claude.json"), {
            mcpServers: {
                github: {
                    command: "${MCP_BINARY}",
                    args: ["${MCP_MODE:-stdio}"],
                },
            },
        });
        await json(join(home, ".claude", "settings.json"), {
            env: { MCP_BINARY: "unknown-user-server" },
        });
        await json(join(cwd, ".claude", "settings.json"), {
            env: { MCP_BINARY: "unknown-project-server" },
        });
        await json(join(cwd, ".claude", "settings.local.json"), {
            env: { MCP_BINARY: github.command },
        });
        const { servers } = await discover();
        expect(servers.github).toMatchObject({
            command: proxy[0],
            args: [...proxy.slice(1), "${MCP_BINARY}", "${MCP_MODE:-stdio}"],
        });
    });

    it("honors CLAUDE_CONFIG_DIR instead of the default HOME config", async () => {
        env.CLAUDE_CONFIG_DIR = join(directory, "custom");
        await json(join(home, ".claude.json"), {
            mcpServers: { ignored: github },
        });
        await json(join(env.CLAUDE_CONFIG_DIR, ".claude.json"), {
            mcpServers: { selected: github },
        });
        expect(Object.keys((await discover()).servers)).toEqual(["selected"]);
    });

    it("applies user, project, local, and explicit precedence without requiring trust for the winning local source", async () => {
        await json(join(home, ".claude.json"), {
            mcpServers: { github: { ...github, args: ["user"] } },
            projects: {
                [cwd]: {
                    mcpServers: { github: { ...github, args: ["local"] } },
                },
            },
        });
        await json(join(cwd, ".mcp.json"), {
            mcpServers: { github: { ...github, args: ["project"] } },
        });
        expect((await discover()).servers.github).toMatchObject({
            args: [...proxy.slice(1), github.command, "local"],
        });
        const explicit = JSON.stringify({
            mcpServers: { github: { ...github, args: ["explicit"] } },
        });
        expect(
            (await discover([`--mcp-config=${explicit}`])).servers.github,
        ).toMatchObject({
            args: [...proxy.slice(1), github.command, "explicit"],
        });
    });

    it.each([
        [false, true],
        [true, false],
    ])(
        "rejects project GitHub without both trust (%s) and MCP approval (%s)",
        async (trusted, approved) => {
            await json(join(home, ".claude.json"), {
                projects: { [cwd]: { hasTrustDialogAccepted: trusted } },
            });
            await json(join(cwd, ".claude", "settings.json"), {
                enableAllProjectMcpServers: approved,
            });
            await json(join(cwd, ".mcp.json"), { mcpServers: { github } });
            await expect(discover()).rejects.toThrow(
                "project trust and MCP approval",
            );
        },
    );

    it("accepts a trusted, explicitly approved root server from a nested working directory", async () => {
        const root = cwd;
        await json(join(home, ".claude.json"), {
            projects: { [root]: { hasTrustDialogAccepted: true } },
        });
        await json(join(root, ".claude", "settings.json"), {
            enabledMcpjsonServers: ["github"],
        });
        await json(join(root, ".mcp.json"), { mcpServers: { github } });
        cwd = join(root, "nested");
        await mkdir(cwd);
        expect((await discover()).servers.github).toMatchObject({
            command: proxy[0],
        });
    });

    it("keeps project rejections from earlier settings sources despite later enable-all", async () => {
        await json(join(home, ".claude.json"), {
            projects: { [cwd]: { hasTrustDialogAccepted: true } },
        });
        await json(join(home, ".claude", "settings.json"), {
            disabledMcpjsonServers: ["github"],
        });
        await json(join(cwd, ".claude", "settings.local.json"), {
            disabledMcpjsonServers: [],
            enableAllProjectMcpServers: true,
        });
        await json(join(cwd, ".mcp.json"), { mcpServers: { github } });
        expect((await discover()).servers).toEqual({});
    });

    it("honors user and local disabled servers even over explicit configs", async () => {
        await json(join(home, ".claude.json"), {
            disabledMcpServers: ["user"],
            projects: { [cwd]: { disabledMcpServers: ["local"] } },
        });
        expect(
            (
                await discover([
                    `--mcp-config=${JSON.stringify({ mcpServers: { user: github, local: github } })}`,
                ])
            ).servers,
        ).toEqual({});
    });

    it("strict config ignores automatic sources and rewrites explicit file and inline options in order", async () => {
        await json(join(home, ".claude.json"), {
            mcpServers: { ignored: github },
        });
        await json(join(cwd, "explicit.json"), {
            mcpServers: { github: { ...github, args: ["file"] } },
        });
        const inline = JSON.stringify({
            mcpServers: {
                github: { ...github, args: ["inline"] },
                custom: { command: "custom-server" },
            },
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const result = await discover([
            "--strict-mcp-config",
            "--mcp-config",
            "explicit.json",
            `--mcp-config=${inline}`,
            "--print",
            "hello",
        ]);
        expect(result.args).toEqual([
            "--strict-mcp-config",
            "--print",
            "hello",
        ]);
        expect(Object.keys(result.servers)).toEqual(["github", "custom"]);
        expect(result.servers.github).toMatchObject({
            args: [...proxy.slice(1), github.command, "inline"],
        });
        expect(result.servers.custom).toEqual({ command: "custom-server" });
    });

    it("does not interpret config options after the positional delimiter", async () => {
        expect(await discover(["--", "--mcp-config=missing.json"])).toEqual({
            servers: {},
        });
    });

    it("rejects the reserved native approval alias", async () => {
        env.AGENTIAM_NATIVE_APPROVAL_SOCKET = join(directory, "native.sock");
        await json(join(home, ".claude.json"), {
            mcpServers: { agentiam: github },
        });
        await expect(discover()).rejects.toThrow("reserved");
    });

    it.each([
        "allowedMcpServers",
        "deniedMcpServers",
        "allowManagedMcpServersOnly",
    ])("rejects wrapping under native %s restrictions", async (key) => {
        await json(join(home, ".claude.json"), { mcpServers: { github } });
        await json(join(home, ".claude", "settings.json"), {
            [key]: key === "allowManagedMcpServersOnly" ? true : [],
        });
        await expect(discover()).rejects.toThrow(
            "native MCP allowlist or denylist",
        );
    });

    it("rejects hosted GitHub HTTP after resolving settings.env", async () => {
        await json(join(home, ".claude.json"), {
            mcpServers: { github: { type: "http", url: "${GITHUB_MCP_URL}" } },
        });
        await json(join(home, ".claude", "settings.json"), {
            env: { GITHUB_MCP_URL: "https://api.githubcopilot.com/mcp/" },
        });
        await expect(discover()).rejects.toThrow("over HTTP");
    });

    it.each([
        "--settings=custom.json",
        "--setting-sources",
        "--worktree",
        "-wbranch",
    ])("rejects unsupported discovery option %s", async (arg) => {
        await expect(discover([arg])).rejects.toThrow(
            "cannot automatically discover",
        );
    });

    it.each([
        [["--mcp-config"], "unambiguous"],
        [["--mcp-config", "one.json", "two.json"], "unambiguous"],
        [["--mcp-config={"], "cannot parse"],
        [["--mcp-config=missing.json"], "cannot find"],
    ])("rejects unsafe explicit config arguments %j", async (args, message) => {
        await expect(discover(args)).rejects.toThrow(message);
    });

    it("rejects unresolved variables in a recognized command", async () => {
        await json(join(home, ".claude.json"), {
            mcpServers: { github: { ...github, args: ["${UNRESOLVED}"] } },
        });
        await expect(discover()).rejects.toThrow("cannot resolve");
    });
});
