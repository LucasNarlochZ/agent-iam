import type { Plugin } from "@opencode/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../../src/harnesses/opencode-plugin.js";

type Server =
    | {
          type: "local";
          command: string[];
          environment?: Record<string, string>;
          disabled?: boolean;
      }
    | { type: "remote"; url: string; disabled?: boolean };

describe("OpenCode MCP registry autowrapping", () => {
    const location = "/isolated/effective-project";
    const prefix = [
        "/runtime/node",
        "/runtime/agentiam.js",
        "mcp",
        "github",
        "--",
    ];

    beforeEach(() => {
        vi.stubEnv("AGENTIAM_NODE", prefix[0]);
        vi.stubEnv("AGENTIAM_ENTRYPOINT", prefix[1]);
        vi.stubEnv("AGENTIAM_NATIVE_APPROVAL_SOCKET", undefined);
        vi.stubEnv("AGENTIAM_MCP_POLICY_CWD", "/stale/launcher-project");
        vi.stubEnv("AGENTIAM_MCP_POLICY_HOME", "/isolated/home");
        vi.stubEnv("AGENTIAM_AUDIT_DIRECTORY", "/isolated/audit");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    async function setup(servers: Record<string, Server>) {
        const updates: string[] = [];
        const transform = vi.fn(async (callback: (editor: unknown) => void) => {
            callback({
                list: () => Object.entries(servers),
                update: (name: string, update: (draft: Server) => void) => {
                    updates.push(name);
                    update(servers[name]!);
                },
            });
        });
        await plugin.setup({
            location: { directory: location },
            mcp: { transform },
        } as unknown as Plugin.Context);
        return { updates, transform };
    }

    it("wraps the effective registry command and preserves args and environment", async () => {
        const command = [
            "docker",
            "run",
            "--rm",
            "-i",
            "-e",
            "GITHUB_PERSONAL_ACCESS_TOKEN",
            "ghcr.io/github/github-mcp-server:v1",
        ];
        const servers: Record<string, Server> = {
            github: {
                type: "local",
                command: [...command],
                environment: {
                    GITHUB_PERSONAL_ACCESS_TOKEN: "test-only-placeholder",
                    CUSTOM: "kept",
                    AGENTIAM_MCP_POLICY_CWD: "/incorrect/server-cwd",
                },
            },
        };
        expect((await setup(servers)).updates).toEqual(["github"]);
        expect(servers.github).toEqual({
            type: "local",
            command: [...prefix, ...command],
            environment: {
                GITHUB_PERSONAL_ACCESS_TOKEN: "test-only-placeholder",
                CUSTOM: "kept",
                AGENTIAM_MCP_POLICY_CWD: location,
                AGENTIAM_MCP_POLICY_HOME: "/isolated/home",
                AGENTIAM_AUDIT_DIRECTORY: "/isolated/audit",
            },
        });
        expect(process.env.AGENTIAM_MCP_POLICY_CWD).toBe(
            "/stale/launcher-project",
        );
    });

    it("skips disabled local and hosted HTTP servers without warnings", async () => {
        const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const servers: Record<string, Server> = {
            local: {
                type: "local",
                command: ["github-mcp-server", "stdio"],
                disabled: true,
            },
            hosted: {
                type: "remote",
                url: "https://api.githubcopilot.com/mcp/",
                disabled: true,
            },
        };
        const before = structuredClone(servers);
        expect((await setup(servers)).updates).toEqual([]);
        expect(servers).toEqual(before);
        expect(warning).not.toHaveBeenCalled();
    });

    it("leaves unknown local and remote servers unchanged with an enforcement warning", async () => {
        const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const servers: Record<string, Server> = {
            local: {
                type: "local",
                command: ["custom-server", "--arg"],
                environment: { CUSTOM: "kept" },
            },
            remote: { type: "remote", url: "https://example.com/mcp" },
        };
        const before = structuredClone(servers);
        expect((await setup(servers)).updates).toEqual([]);
        expect(servers).toEqual(before);
        expect(warning).toHaveBeenCalledTimes(2);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("outside Agent IAM enforcement"),
        );
    });

    it("disables hosted GitHub HTTP without preventing recognized stdio wrapping", async () => {
        const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const servers: Record<string, Server> = {
            hosted: {
                type: "remote",
                url: "https://api.githubcopilot.com/mcp/",
            },
            stdio: { type: "local", command: ["github-mcp-server", "stdio"] },
        };
        expect((await setup(servers)).updates).toEqual(["hosted", "stdio"]);
        expect(servers.hosted).toMatchObject({ disabled: true });
        expect(servers.stdio).toMatchObject({
            command: [...prefix, "github-mcp-server", "stdio"],
        });
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("Disabled a registered HTTP MCP server"),
        );
    });

    it("does not double-wrap an existing proxy command", async () => {
        const servers: Record<string, Server> = {
            github: {
                type: "local",
                command: [...prefix, "github-mcp-server", "stdio"],
            },
        };
        await setup(servers);
        expect(servers.github).toMatchObject({
            command: [...prefix, "github-mcp-server", "stdio"],
        });
    });

    it.each(["AGENTIAM_NODE", "AGENTIAM_ENTRYPOINT"])(
        "does not transform registries without %s",
        async (key) => {
            vi.stubEnv(key, undefined);
            const servers: Record<string, Server> = {
                github: { type: "local", command: ["github-mcp-server"] },
            };
            const { transform } = await setup(servers);
            expect(transform).not.toHaveBeenCalled();
            expect(servers.github).toMatchObject({
                command: ["github-mcp-server"],
            });
        },
    );
});
