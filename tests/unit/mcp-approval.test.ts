import { describe, expect, it } from "vitest";
import { requestMcpApproval } from "../../src/mcp/mcp-approval.js";

describe("MCP approval", () => {
    it("requests a native choice and returns the selected approval", async () => {
        const requests: unknown[] = [];

        const choice = await requestMcpApproval(
            {
                service: "github",
                action: "merge",
                canonical: "github.pr.merge",
                constraints: { repository: "owner/repo" },
            },
            async (input) => {
                requests.push(input);
                return {
                    action: "accept",
                    content: {
                        choice: requests.length === 1 ? "allow" : "repos",
                    },
                };
            },
        );

        expect(choice).toEqual({ choice: "allow-context", scope: ["repos"] });
        expect(requests).toHaveLength(2);
        expect(requests[0]).toEqual({
            mode: "form",
            message:
                "[agentiam] github.pr.merge was denied.\nConstraints: repository:owner/repo",
            requestedSchema: {
                type: "object",
                properties: {
                    choice: {
                        type: "string",
                        title: "Agent IAM policy decision",
                        oneOf: [
                            {
                                const: "allow",
                                title: "Allow permanently",
                            },
                            { const: "allow-once", title: "Allow once" },
                            { const: "deny", title: "Deny permanently" },
                            { const: "skip", title: "Skip" },
                        ],
                    },
                },
                required: ["choice"],
            },
        });
    });

    it("maps declined and invalid responses to skip", async () => {
        const capability = {
            service: "aws",
            action: "s3.ls",
            canonical: "aws.s3.ls",
        };

        await expect(
            requestMcpApproval(capability, async () => ({
                action: "decline",
                content: null,
            })),
        ).resolves.toBe("skip");
        await expect(
            requestMcpApproval(capability, async () => ({
                action: "accept",
                content: { choice: "invalid" },
            })),
        ).resolves.toBe("skip");
    });
});
