import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";

describe("version command", () => {
    it("prints the package version without loading a policy", async () => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const { version } = JSON.parse(
            await readFile(
                new URL("../../package.json", import.meta.url),
                "utf8",
            ),
        );

        await expect(
            main(["--version"], { env: {}, output: { stdout, stderr } }),
        ).resolves.toBe(0);
        expect(stdout.read()?.toString()).toBe(`${version}\n`);
        expect(stderr.read()).toBeNull();
    });

    it("rejects extra arguments", async () => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();

        await expect(
            main(["--version", "extra"], { output: { stdout, stderr } }),
        ).resolves.toBe(1);
        expect(stdout.read()).toBeNull();
        expect(stderr.read()?.toString()).toBe(
            "agentiam --version does not accept arguments\n",
        );
    });
});

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
