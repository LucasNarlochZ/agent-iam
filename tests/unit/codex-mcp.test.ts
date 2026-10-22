import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    codexConfigArgs,
    prepareCodexMcp,
} from "../../src/harnesses/codex-mcp.js";

describe("Codex MCP config arguments", () => {
    it("normalizes all override forms in their original precedence order", () => {
        expect(
            codexConfigArgs([
                "exec",
                "-c",
                "a=1",
                "--config",
                "a=2",
                "--config=a=3",
                "-c=a=4",
                "-ca=5",
                "prompt",
            ]),
        ).toEqual({
            config: [
                "--config",
                "a=1",
                "--config",
                "a=2",
                "--config",
                "a=3",
                "--config",
                "a=4",
                "--config",
                "a=5",
            ],
            rest: ["exec", "prompt"],
        });
    });

    it("preserves everything after the positional delimiter", () => {
        expect(
            codexConfigArgs(["-cx=1", "--", "-cx=2", "--config", "x=3"]),
        ).toEqual({
            config: ["--config", "x=1"],
            rest: ["--", "-cx=2", "--config", "x=3"],
        });
    });

    it.each(["--config", "-c"])("rejects missing %s values", (arg) => {
        expect(() => codexConfigArgs([arg])).toThrow(
            "Missing Codex config override",
        );
    });
});

describe("Codex MCP discovery and override verification", () => {
    let directory: string;
    let command: string;
    let env: NodeJS.ProcessEnv;
    const github = {
        name: "github",
        enabled: true,
        transport: {
            type: "stdio",
            command: "github-mcp-server",
            args: ["stdio"],
            env: { ORIGINAL: "preserved" },
        },
    };
    const proxy = [
        "/runtime/node",
        "/runtime/agentiam.js",
        "mcp",
        "github",
        "--",
    ];

    async function servers(value: unknown) {
        await writeFile(join(directory, "servers.json"), JSON.stringify(value));
    }

    async function calls(): Promise<
        { args: string[]; cwd: string; home: string }[]
    > {
        return (await readFile(join(directory, "calls.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
    }

    async function prepare(args: string[] = []) {
        await prepareCodexMcp(env, command, { cwd: directory, args });
    }

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "agentiam-codex-mcp-"));
        const home = join(directory, "home");
        await mkdir(home);
        command = join(directory, "fake-codex");
        env = {
            HOME: home,
            CODEX_HOME: join(home, ".codex"),
            AGENTIAM_NODE: proxy[0],
            AGENTIAM_ENTRYPOINT: proxy[1],
            AGENTIAM_MCP_POLICY_HOME: home,
            AGENTIAM_AUDIT_DIRECTORY: join(directory, "audit"),
            FAKE_DIRECTORY: directory,
        };
        await writeFile(
            command,
            `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const directory = process.env.FAKE_DIRECTORY;
const args = process.argv.slice(2);
appendFileSync(directory + '/calls.jsonl', JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME }) + '\\n');
const overrides = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config') overrides.push(args[++i]);
}
const verifying = overrides.some(value => value.includes('.required=true'));
const mode = process.env.FAKE_MODE;
if (mode === 'discovery-error' || (verifying && mode === 'verification-error')) process.exit(1);
if (mode === 'discovery-json') { process.stdout.write('{'); process.exit(0); }
const servers = JSON.parse(readFileSync(directory + '/servers.json', 'utf8'));
for (const override of overrides) {
    if (verifying && mode === 'ignore-overrides') continue;
    const separator = override.indexOf('=');
    const path = override.slice(0, separator).split('.');
    if (path.shift() !== 'mcp_servers') continue;
    const server = servers.find(server => server.name === path.shift());
    if (!server) continue;
    let target = server.transport;
    while (path.length > 1) { const key = path.shift(); target = target[key] ??= {}; }
    target[path[0]] = JSON.parse(override.slice(separator + 1));
}
if (verifying && mode === 'wrong-command') servers[0].transport.command = 'unwrapped';
if (verifying && mode === 'wrong-args') servers[0].transport.args = [];
if (verifying && mode === 'missing-env') servers[0].transport.env = {};
if (verifying && mode === 'missing-server') servers.length = 0;
if (verifying && mode === 'verification-shape') { process.stdout.write('{}'); process.exit(0); }
if (verifying && mode === 'verification-json') { process.stdout.write('{'); process.exit(0); }
process.stdout.write(JSON.stringify(servers));
`,
            { mode: 0o700 },
        );
        await servers([github]);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(directory, { recursive: true, force: true });
    });

    it("discovers with user overrides first, verifies proxy overrides last, and leaves source files unchanged", async () => {
        const before = await readFile(join(directory, "servers.json"), "utf8");
        const userConfig = 'mcp_servers.github.args=["custom"]';
        await prepare(["exec", "-c", userConfig, "hello"]);
        const overrides = JSON.parse(env.AGENTIAM_CODEX_MCP_OVERRIDES!);
        expect(overrides).toEqual([
            "--config",
            `mcp_servers.github.command=${JSON.stringify(proxy[0])}`,
            "--config",
            `mcp_servers.github.args=${JSON.stringify([...proxy.slice(1), "github-mcp-server", "custom"])}`,
            "--config",
            "mcp_servers.github.required=true",
            "--config",
            `mcp_servers.github.env.AGENTIAM_AUDIT_DIRECTORY=${JSON.stringify(env.AGENTIAM_AUDIT_DIRECTORY)}`,
            "--config",
            `mcp_servers.github.env.AGENTIAM_MCP_POLICY_CWD=${JSON.stringify(directory)}`,
            "--config",
            `mcp_servers.github.env.AGENTIAM_MCP_POLICY_HOME=${JSON.stringify(env.AGENTIAM_MCP_POLICY_HOME)}`,
        ]);
        expect(await calls()).toEqual([
            {
                args: ["--config", userConfig, "mcp", "list", "--json"],
                cwd: directory,
                home: env.HOME,
            },
            {
                args: [
                    "--config",
                    userConfig,
                    ...overrides,
                    "mcp",
                    "list",
                    "--json",
                ],
                cwd: directory,
                home: env.HOME,
            },
        ]);
        expect(await readFile(join(directory, "servers.json"), "utf8")).toBe(
            before,
        );
    });

    it.each(["--cd", "--cd=", "-C", "-C=", "-Cjoined"])(
        "uses the effective cwd for %s during both discovery and verification",
        async (flag) => {
            const nested = join(directory, "nested");
            await mkdir(nested);
            const args =
                flag === "-Cjoined"
                    ? ["-Cnested"]
                    : flag.endsWith("=")
                      ? [`${flag}nested`]
                      : [flag, "nested"];
            await prepare(args);
            expect(env.AGENTIAM_MCP_POLICY_CWD).toBe(nested);
            expect((await calls()).map((call) => call.cwd)).toEqual([
                nested,
                nested,
            ]);
            expect(JSON.parse(env.AGENTIAM_CODEX_MCP_OVERRIDES!)).toContain(
                `mcp_servers.github.env.AGENTIAM_MCP_POLICY_CWD=${JSON.stringify(nested)}`,
            );
        },
    );

    it("ignores working directory flags after the positional delimiter", async () => {
        await prepare(["--", "--cd", "missing"]);
        expect(env.AGENTIAM_MCP_POLICY_CWD).toBe(directory);
    });

    it.each(["discovery-error", "discovery-json"])(
        "fails closed on %s",
        async (mode) => {
            env.FAKE_MODE = mode;
            await expect(prepare()).rejects.toThrow("Unable to discover");
            expect(env.AGENTIAM_CODEX_MCP_OVERRIDES).toBeUndefined();
        },
    );

    it.each([
        "verification-error",
        "ignore-overrides",
        "wrong-command",
        "wrong-args",
        "missing-env",
        "missing-server",
        "verification-shape",
        "verification-json",
    ])("fails closed when override verification returns %s", async (mode) => {
        env.FAKE_MODE = mode;
        await expect(prepare()).rejects.toThrow(
            "did not apply the MCP proxy overrides",
        );
        expect(env.AGENTIAM_CODEX_MCP_OVERRIDES).toBeUndefined();
        expect(await calls()).toHaveLength(2);
    });

    it.each([
        "--profile=custom",
        "-pcustom",
        "--remote",
        "--worktree",
        "-wbranch",
    ])("rejects unsupported %s before discovery", async (arg) => {
        await expect(prepare([arg])).rejects.toThrow(
            "does not support profiles",
        );
        await expect(
            readFile(join(directory, "calls.jsonl")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["--cd", "-C"])(
        "rejects missing working directory values for %s",
        async (arg) => {
            await expect(prepare([arg])).rejects.toThrow(
                "Missing Codex working directory",
            );
        },
    );

    it("rejects hosted GitHub HTTP", async () => {
        await servers([
            {
                name: "github",
                transport: {
                    type: "streamable_http",
                    url: "https://api.githubcopilot.com/mcp/",
                },
            },
        ]);
        await expect(prepare()).rejects.toThrow("over HTTP");
    });

    it("skips disabled servers before inspecting their transport", async () => {
        await servers([
            { name: "github", enabled: false },
            {
                name: "http",
                enabled: false,
                transport: {
                    type: "http",
                    url: "https://api.githubcopilot.com/mcp/",
                },
            },
        ]);
        await prepare();
        expect(JSON.parse(env.AGENTIAM_CODEX_MCP_OVERRIDES!)).toEqual([]);
        expect(await calls()).toHaveLength(1);
    });

    it("warns about unknown stdio and HTTP servers without rewriting them", async () => {
        const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        await servers([
            {
                name: "other",
                transport: { type: "stdio", command: "other-server", args: [] },
            },
            {
                name: "remote",
                transport: { type: "http", url: "https://example.com/mcp" },
            },
        ]);
        await prepare();
        expect(warning).toHaveBeenCalledTimes(2);
        expect(JSON.parse(env.AGENTIAM_CODEX_MCP_OVERRIDES!)).toEqual([]);
        expect(await calls()).toHaveLength(1);
    });

    it.each([
        [{}, "discovery response"],
        [[null], "server definition"],
        [[{ name: "broken" }], "transport definition"],
        [
            [{ ...github, transport: { ...github.transport, args: [1] } }],
            "stdio definition",
        ],
        [[{ ...github, name: "agentiam" }], "reserved"],
        [[{ ...github, name: "unsafe.name" }], "safely override"],
    ])(
        "rejects malformed or unsafe discovered servers %j",
        async (value, message) => {
            await servers(value);
            await expect(prepare()).rejects.toThrow(message);
        },
    );
});
