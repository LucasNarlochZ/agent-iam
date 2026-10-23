import type { CanonicalCapability } from "../capability.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as NativeMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { once } from "node:events";
import { startApprovalBroker } from "../approvals/approval-broker.js";
import {
    createApprovalPlan,
    selectApproval,
    type ApprovalContext,
    type ApprovalDecision,
} from "../approvals/approval.js";

interface ElicitationRequest {
    mode: "form";
    message: string;
    requestedSchema: {
        type: "object";
        properties: {
            choice: {
                type: "string";
                title: string;
                oneOf: Array<{ const: string; title: string }>;
            };
        };
        required: ["choice"];
    };
}

interface ElicitationResponse {
    action: string;
    content?: Record<string, unknown> | null;
}

type Elicit = (request: ElicitationRequest) => Promise<ElicitationResponse>;

export async function requestMcpApproval(
    capability: CanonicalCapability,
    elicit: Elicit,
    context?: ApprovalContext,
): Promise<ApprovalDecision> {
    return selectApproval(
        await createApprovalPlan(capability, context),
        async (message, choices) => {
            const response = await elicit({
                mode: "form",
                message,
                requestedSchema: {
                    type: "object",
                    properties: {
                        choice: {
                            type: "string",
                            title: "Agent IAM policy decision",
                            oneOf: choices.map(({ label, value }) => ({
                                const: value,
                                title: label,
                            })),
                        },
                    },
                    required: ["choice"],
                },
            });
            const choice = response.content?.choice;
            return response.action === "accept" &&
                typeof choice === "string" &&
                choices.some(({ value }) => value === choice)
                ? choice
                : "skip";
        },
    );
}

export function startMcpApprovalSocket(
    path: string,
    server: McpServer,
): Promise<{ close(): Promise<void> }> {
    return startApprovalBroker(path, (capability, context) =>
        requestMcpApproval(
            capability,
            (request) => server.server.elicitInput(request),
            context,
        ),
    );
}

export function createMcpApprovalServer(): McpServer {
    const server = new NativeMcpServer({
        name: "agentiam",
        version: "0.2.0",
    });
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [],
    }));
    return server;
}

export async function serveMcpApprovals(path: string): Promise<void> {
    const server = createMcpApprovalServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    const socket = await startMcpApprovalSocket(path, server);
    try {
        await once(process.stdin, "end");
    } finally {
        await socket.close();
        await server.close();
    }
}
