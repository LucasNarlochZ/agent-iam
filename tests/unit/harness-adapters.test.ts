import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    getHarnessAdapter,
    genericHarnessAdapter,
    type HarnessAdapter,
} from "../../src/harnesses/index.js";

describe("harness adapters", () => {
    it("uses the generic adapter for non-Codex commands", () => {
        expect(getHarnessAdapter("unknown-agent")).toBe(genericHarnessAdapter);
    });

    it("configures Claude Code for native MCP elicitation approvals", async () => {
        const adapter = getHarnessAdapter("/usr/local/bin/claude");
        const args = ["--model", "sonnet", "--", "help me"];
        const env: NodeJS.ProcessEnv = {
            AGENTIAM_NODE: "/usr/bin/node",
            AGENTIAM_ENTRYPOINT: "/app/dist/index.js",
            AGENTIAM_NATIVE_APPROVAL_SOCKET: "/tmp/agentiam/native.sock",
        };
        const directory = await mkdtemp(join(tmpdir(), "agentiam-claude-"));

        expect(adapter).not.toBe(genericHarnessAdapter);
        expect(adapter.nativeApprovals).toBe(true);
        await adapter.prepare?.(env, directory);
        const commandArgs = adapter.commandArgs(args, env);
        const configPath =
            commandArgs[commandArgs.indexOf("--mcp-config") + 1]!;
        expect(commandArgs).toEqual(["--mcp-config", configPath, ...args]);
        expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
            mcpServers: {
                agentiam: {
                    type: "stdio",
                    command: "/usr/bin/node",
                    args: ["/app/dist/index.js", "__mcp"],
                    env: {
                        AGENTIAM_NATIVE_APPROVAL_SOCKET:
                            "/tmp/agentiam/native.sock",
                    },
                },
            },
        });
    });

    it("launches OpenCode with a private server and its native approval plugin", async () => {
        const adapter = getHarnessAdapter("/usr/bin/opencode");
        const env = {
            AGENTIAM_ENTRYPOINT: "/app/dist/index.js",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: ["existing"] }),
        };
        const directory = await mkdtemp(join(tmpdir(), "agentiam-adapter-"));
        await adapter.prepare?.(env, directory);
        expect(adapter.nativeApprovals).toBe(true);
        expect(adapter.commandArgs(["run", "hello"], env)).toEqual([
            "run",
            "--standalone",
            "hello",
        ]);
        expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).plugins).toEqual([
            "existing",
            pathToFileURL(join(directory, "opencode-plugin")).href,
        ]);
        expect(
            await readFile(join(directory, "opencode-plugin/tui.js"), "utf8"),
        ).toContain("opencode-tui-plugin.js");
    });

    it("uses the inherited shim environment and terminal approvals for OpenCode V1", async () => {
        const adapter = getHarnessAdapter("/usr/bin/opencode");
        const env: NodeJS.ProcessEnv = {
            AGENTIAM_ENTRYPOINT: "/app/dist/index.js",
        };
        const directory = await mkdtemp(join(tmpdir(), "agentiam-adapter-"));
        await adapter.prepare?.(env, directory, "/usr/bin/opencode", "1.19.0");
        expect(env.AGENTIAM_OPENCODE_V1).toBe("1");
        expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
        expect(adapter.commandArgs(["run", "hello"], env)).toEqual([
            "run",
            "hello",
        ]);
        expect(
            adapter.nativeApprovals && env.AGENTIAM_OPENCODE_V1 !== "1",
        ).toBe(false);
        expect(() => adapter.commandArgs(["--attach"], env)).toThrow(
            /private server/,
        );
    });

    it("rejects OpenCode connections to an existing server", () => {
        expect(() =>
            getHarnessAdapter("opencode").commandArgs(
                ["--server=http://localhost:4096"],
                {},
            ),
        ).toThrow(/private server/);
    });

    it("selects adapters from the harness registry", () => {
        const adapter: HarnessAdapter = {
            nativeApprovals: false,
            commandArgs: (args) => ["--custom", ...args],
        };

        expect(
            getHarnessAdapter("custom-agent", {
                custom: {
                    matches: (command) => command === "custom-agent",
                    adapter,
                },
            }),
        ).toBe(adapter);
    });

    it("configures Codex command arguments and native approvals", () => {
        const adapter = getHarnessAdapter("/usr/bin/codex");

        expect(adapter.nativeApprovals).toBe(true);
        expect(
            adapter.commandArgs(["--model", "x"], {
                PATH: "/tmp/agentiam:/usr/bin",
                AGENTIAM_NODE: "/usr/bin/node",
                AGENTIAM_ENTRYPOINT: "/app/dist/index.js",
                AGENTIAM_NATIVE_APPROVAL_SOCKET:
                    "/tmp/agentiam/native-approval.sock",
            }),
        ).toEqual([
            "--config",
            'shell_environment_policy.set.PATH="/tmp/agentiam:/usr/bin"',
            "--config",
            'mcp_servers.agentiam.command="/usr/bin/node"',
            "--config",
            'mcp_servers.agentiam.args=["/app/dist/index.js","__mcp"]',
            "--config",
            'mcp_servers.agentiam.env.AGENTIAM_NATIVE_APPROVAL_SOCKET="/tmp/agentiam/native-approval.sock"',
            "--config",
            "mcp_servers.agentiam.required=true",
            "--model",
            "x",
        ]);
    });
});
