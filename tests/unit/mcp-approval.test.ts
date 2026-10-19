import { describe, expect, it } from "vitest";
import { requestMcpApproval } from "../../src/mcp-approval.js";

describe("MCP approval", () => {
    it("requests a native choice and returns the selected approval", async () => {
        let request: unknown;

        const choice = await requestMcpApproval(
            {
                service: "github",
                action: "merge",
                canonical: "github.pr.merge",
                constraints: { repository: "owner/repo" },
            },
            async (input) => {
                request = input;
                return {
                    action: "accept",
                    content: { choice: "allow-context" },
                };
            },
        );

        expect(choice).toBe("allow-context");
        expect(request).toEqual({
            mode: "form",
            message: "[agentiam] github.pr.merge was denied.",
            requestedSchema: {
                type: "object",
                properties: {
                    choice: {
                        type: "string",
                        title: "Agent IAM policy decision",
                        oneOf: [
                            {
                                const: "allow",
                                title: "Allow this capability",
                            },
                            {
                                const: "allow-context",
                                title: "Allow for repository owner/repo",
                            },
                            { const: "allow-once", title: "Allow once" },
                            { const: "deny", title: "Explicitly deny" },
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
