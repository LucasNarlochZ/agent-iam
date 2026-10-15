import { describe, expect, it } from "vitest";
import {
    getHarnessAdapter,
    genericHarnessAdapter,
    type HarnessAdapter,
} from "../../src/harness-adapters.js";

describe("harness adapters", () => {
    it("uses the generic adapter for non-Codex commands", () => {
        expect(getHarnessAdapter("opencode")).toBe(genericHarnessAdapter);
    });

    it("selects adapters from the harness registry", () => {
        const adapter: HarnessAdapter = {
            nativeApprovals: false,
            commandArgs: (args) => ["--custom", ...args],
        };

        expect(
            getHarnessAdapter("custom-agent", {
                custom: { matches: (command) => command === "custom-agent", adapter },
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
