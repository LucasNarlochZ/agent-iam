import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("approval broker", () => {
    it("forwards a nested approval request to the parent prompt", async () => {
        const { requestBrokerApproval, startApprovalBroker } =
            await import("../../src/approval-broker.js");
        const directory = await mkdtemp(join(tmpdir(), "agentiam-broker-"));
        const socketPath = join(directory, "approval.sock");
        const broker = await startApprovalBroker(
            socketPath,
            async (capability) => {
                expect(capability.canonical).toBe(
                    "aws.sts.get-caller-identity",
                );
                return "allow";
            },
        );

        await expect(
            requestBrokerApproval(socketPath, {
                service: "aws",
                action: "get-caller-identity",
                canonical: "aws.sts.get-caller-identity",
            }),
        ).resolves.toBe("allow");

        await broker.close();
    });
});
