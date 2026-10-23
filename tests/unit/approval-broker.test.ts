import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";

describe("approval broker", () => {
    it("rejects a null socket request without invoking the approval prompt", async () => {
        const { startApprovalBroker } =
            await import("../../src/approvals/approval-broker.js");
        const directory = await mkdtemp(
            join(tmpdir(), "agentiam-invalid-approval-"),
        );
        const path = join(directory, "approval.sock");
        let prompted = false;
        const broker = await startApprovalBroker(path, async () => {
            prompted = true;
            return "allow";
        });
        try {
            const response = await new Promise<string>((resolve, reject) => {
                const socket = createConnection({ path });
                let response = "";
                socket.once("connect", () => socket.end("null\n"));
                socket.on("data", (data) => (response += data.toString()));
                socket.once("error", reject);
                socket.once("end", () => resolve(response));
            });
            expect(response).toBe("skip\n");
            expect(prompted).toBe(false);
        } finally {
            await broker.close();
        }
    });

    it("persists a scoped local decision through the file broker", async () => {
        const { requestFileApproval, startFileApprovalBroker } =
            await import("../../src/approvals/approval-broker.js");
        const directory = await mkdtemp(
            join(tmpdir(), "agentiam-file-approval-"),
        );
        const cwd = join(directory, "project");
        const globalPolicyPath = join(directory, ".agentiam/policy.yaml");
        const local = join(cwd, ".agentiam/policy.yaml");
        await mkdir(join(directory, ".agentiam"));
        await mkdir(join(cwd, ".agentiam"), { recursive: true });
        await writeFile(globalPolicyPath, "allow: {}\ndeny: {}\n");
        await writeFile(local, "allow: {}\ndeny: {}\n");
        const context = { cwd, globalPolicyPath };
        const decision = {
            choice: "deny-context" as const,
            scope: ["repos"],
            policyPath: local,
        };
        const broker = await startFileApprovalBroker(
            join(directory, "channel"),
            async (_capability, received) => {
                expect(received).toEqual(context);
                return decision;
            },
            { HOME: directory },
        );
        try {
            expect(
                await requestFileApproval(
                    join(directory, "channel"),
                    {
                        service: "github",
                        action: "merge",
                        canonical: "github.pr.merge",
                        constraints: { repository: "owner/repo" },
                    },
                    context,
                ),
            ).toEqual(decision);
            expect(await readFile(local, "utf8")).toContain("owner/repo");
            expect(await readFile(globalPolicyPath, "utf8")).toBe(
                "allow: {}\ndeny: {}\n",
            );
        } finally {
            await broker.close();
        }
    });

    it("forwards the command directory and preserves scoped local decisions", async () => {
        const { requestBrokerApproval, startApprovalBroker } =
            await import("../../src/approvals/approval-broker.js");
        const directory = await mkdtemp(join(tmpdir(), "agentiam-broker-"));
        const socketPath = join(directory, "approval.sock");
        const context = {
            cwd: directory,
            globalPolicyPath: join(directory, "home/.agentiam/policy.yaml"),
        };
        const decision = {
            choice: "deny-context" as const,
            scope: ["repos"],
            policyPath: join(directory, ".agentiam/policy.yaml"),
        };
        const broker = await startApprovalBroker(
            socketPath,
            async (_capability, received) => {
                expect(received).toEqual(context);
                return decision;
            },
        );
        try {
            expect(
                await requestBrokerApproval(
                    socketPath,
                    {
                        service: "github",
                        action: "merge",
                        canonical: "github.pr.merge",
                    },
                    context,
                ),
            ).toEqual(decision);
        } finally {
            await broker.close();
        }
    });

    it("forwards a nested approval request to the parent prompt", async () => {
        const { requestBrokerApproval, startApprovalBroker } =
            await import("../../src/approvals/approval-broker.js");
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
