import { describe, expect, it } from "vitest";
import {
    checkMcpUrl,
    mcpProxyEnvironment,
    proxyMcpCommand,
} from "../../src/mcp/mcp-configuration.js";

const runtime = {
    AGENTIAM_NODE: "/runtime/node",
    AGENTIAM_ENTRYPOINT: "/runtime/agent iam/index.js",
};

describe("MCP command proxy configuration", () => {
    it.each([
        ["github-mcp-server", "stdio"],
        ["/usr/local/bin/github-mcp-server", "--read-only"],
        [
            "docker",
            "run",
            "--rm",
            "-i",
            "-e",
            "GITHUB_PERSONAL_ACCESS_TOKEN",
            "ghcr.io/github/github-mcp-server:latest",
        ],
        ["podman", "run", "ghcr.io/github/github-mcp-server@sha256:abc123"],
    ])("wraps %j without altering its arguments", (...args) => {
        const command = Object.freeze(args);
        expect(proxyMcpCommand(command, runtime)).toEqual([
            runtime.AGENTIAM_NODE,
            runtime.AGENTIAM_ENTRYPOINT,
            "mcp",
            "github",
            "--",
            ...args,
        ]);
        expect(command).toEqual(args);
    });

    it("is idempotent and returns an independent command array", () => {
        const command = Object.freeze(["github-mcp-server", "stdio"]);
        const wrapped = proxyMcpCommand(command, runtime)!;
        const repeated = proxyMcpCommand(Object.freeze(wrapped), runtime);
        expect(repeated).toEqual(wrapped);
        expect(repeated).not.toBe(wrapped);
    });

    it.each([
        {},
        { AGENTIAM_NODE: "/runtime/node" },
        { AGENTIAM_ENTRYPOINT: "/runtime/index.js" },
        { ...runtime, AGENTIAM_NODE: "" },
        { ...runtime, AGENTIAM_ENTRYPOINT: "" },
    ])("requires both runtime values for supported commands: %j", (env) => {
        expect(() => proxyMcpCommand(["github-mcp-server"], env)).toThrow(
            "Missing Agent IAM MCP runtime",
        );
    });

    describe.each([{}, runtime])(
        "unknown commands with environment %j",
        (env) => {
            it.each([
                [],
                ["unknown-mcp", "--flag"],
                ["npx", "other-mcp"],
                ["docker", "run", "other/image"],
                ["docker", "pull", "ghcr.io/github/github-mcp-server"],
                ["/runtime/node", "/other/index.js", "mcp", "github"],
            ])("leaves %j unwrapped", (...command) => {
                expect(proxyMcpCommand(command, env)).toBeUndefined();
            });
        },
    );

    it("does not treat another executable with the same basename as its runtime", () => {
        expect(
            proxyMcpCommand(
                ["/other/node", runtime.AGENTIAM_ENTRYPOINT, "mcp", "github"],
                runtime,
            ),
        ).toBeUndefined();
    });

    it("does not treat a non-MCP runtime invocation as already proxied", () => {
        expect(
            proxyMcpCommand(
                [
                    runtime.AGENTIAM_NODE,
                    runtime.AGENTIAM_ENTRYPOINT,
                    "run",
                    "github-mcp-server",
                ],
                runtime,
            ),
        ).toBeUndefined();
    });
});

describe("MCP proxy environment", () => {
    it("forwards only policy and audit configuration without mutating its source", () => {
        const env = Object.freeze({
            ...runtime,
            AGENTIAM_AUDIT_DIRECTORY: "/audit directory",
            AGENTIAM_MCP_POLICY_CWD: "/project",
            AGENTIAM_MCP_POLICY_HOME: "/home/test",
            PATH: "/usr/bin",
            HOME: "/home/test",
            GITHUB_PERSONAL_ACCESS_TOKEN: "test-token",
            AGENTIAM_UNRECOGNIZED: "not forwarded",
        });
        expect(mcpProxyEnvironment(env)).toEqual({
            AGENTIAM_AUDIT_DIRECTORY: "/audit directory",
            AGENTIAM_MCP_POLICY_CWD: "/project",
            AGENTIAM_MCP_POLICY_HOME: "/home/test",
        });
        expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("test-token");
    });

    it("omits absent and explicitly undefined values", () => {
        expect(mcpProxyEnvironment({})).toEqual({});
        expect(
            mcpProxyEnvironment({
                AGENTIAM_AUDIT_DIRECTORY: undefined,
                AGENTIAM_MCP_POLICY_CWD: undefined,
                AGENTIAM_MCP_POLICY_HOME: undefined,
            }),
        ).toEqual({});
    });

    it.each([
        "AGENTIAM_AUDIT_DIRECTORY",
        "AGENTIAM_MCP_POLICY_CWD",
        "AGENTIAM_MCP_POLICY_HOME",
    ])("preserves an explicitly empty %s", (key) => {
        expect(mcpProxyEnvironment({ [key]: "" })).toEqual({ [key]: "" });
    });

    it("returns an independent object", () => {
        const env = { AGENTIAM_MCP_POLICY_CWD: "/project" };
        const result = mcpProxyEnvironment(env);
        result.AGENTIAM_MCP_POLICY_CWD = "/other";
        expect(env.AGENTIAM_MCP_POLICY_CWD).toBe("/project");
    });
});

describe("MCP HTTP configuration checks", () => {
    it.each([
        "https://api.githubcopilot.com/mcp/",
        "https://API.GITHUBCOPILOT.COM/mcp",
        "http://api.githubcopilot.com/mcp",
        "https://api.githubcopilot.com:8443/mcp?toolsets=issues",
    ])("rejects registered endpoint %s", (url) => {
        expect(() => checkMcpUrl(url)).toThrow(
            "Agent IAM cannot proxy a registered MCP server over HTTP yet; configure its supported stdio command instead",
        );
    });

    it.each([
        "https://example.com/mcp",
        "http://localhost:3000/mcp",
        "https://api.githubcopilot.com.evil.example/mcp",
        "https://api.githubcopilot.com@evil.example/mcp",
        "https://example.com/api.githubcopilot.com",
        "not a URL",
        "",
    ])("leaves unregistered endpoint %j unchanged", (url) => {
        expect(() => checkMcpUrl(url)).not.toThrow();
    });
});
