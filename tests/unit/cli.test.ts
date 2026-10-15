import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";

describe("internal MCP command", () => {
    it("starts the MCP approval server on the configured socket", async () => {
        let socketPath = "";

        await expect(
            main(["__mcp"], {
                env: {
                    AGENTIAM_NATIVE_APPROVAL_SOCKET:
                        "/tmp/agentiam/native-approval.sock",
                },
                output: {
                    stdout: new PassThrough(),
                    stderr: new PassThrough(),
                },
                mcp: async (path) => {
                    socketPath = path;
                },
            }),
        ).resolves.toBe(0);
        expect(socketPath).toBe("/tmp/agentiam/native-approval.sock");
    });
});
