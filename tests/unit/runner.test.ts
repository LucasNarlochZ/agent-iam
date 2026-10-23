import { describe, expect, it } from "vitest";

describe("agent runner", () => {
    it("injects the Agent IAM environment into Codex shell commands", async () => {
        const { commandArgsWithEnvironment } =
            await import("../../src/runtime/runner.js");

        expect(
            commandArgsWithEnvironment(
                "/usr/local/bin/codex",
                ["--model", "x"],
                {
                    PATH: "/tmp/agentiam:/usr/bin",
                    ZDOTDIR: "/tmp/agentiam/shell",
                    BASH_ENV: "/tmp/agentiam/shell/bash-env",
                    ENV: "/tmp/agentiam/shell/sh-env",
                    AGENTIAM_ORIGINAL_PATH: "/usr/bin",
                    AGENTIAM_APPROVAL_SOCKET: "/tmp/agentiam/approval.sock",
                    AGENTIAM_NATIVE_APPROVAL_SOCKET:
                        "/tmp/agentiam/native-approval.sock",
                    AGENTIAM_NODE: "/usr/bin/node",
                    AGENTIAM_ENTRYPOINT: "/app/dist/index.js",
                },
            ),
        ).toEqual([
            "--config",
            'shell_environment_policy.set.PATH="/tmp/agentiam:/usr/bin"',
            "--config",
            'shell_environment_policy.set.ZDOTDIR="/tmp/agentiam/shell"',
            "--config",
            'shell_environment_policy.set.BASH_ENV="/tmp/agentiam/shell/bash-env"',
            "--config",
            'shell_environment_policy.set.ENV="/tmp/agentiam/shell/sh-env"',
            "--config",
            'shell_environment_policy.set.AGENTIAM_ORIGINAL_PATH="/usr/bin"',
            "--config",
            'shell_environment_policy.set.AGENTIAM_APPROVAL_SOCKET="/tmp/agentiam/approval.sock"',
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
        expect(
            commandArgsWithEnvironment("unknown-agent", ["--model", "x"], {}),
        ).toEqual(["--model", "x"]);
    });
});
