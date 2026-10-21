import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { appendAuditRecord, type AuditRecord } from "./audit.js";
import { requestAuditWrite } from "./audit-broker.js";
import { capability } from "./capability.js";
import { evaluatePolicies } from "./policy/engine.js";
import { loadPolicy, resolvePolicyPath } from "./policy/schema.js";
import { mcpTools, type McpToolName, type McpAuditToolName } from "./tools.js";

export interface McpProxyOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}

type McpUpstream = Pick<Client, "listTools" | "callTool">;

function failure(text: string) {
    return { isError: true, content: [{ type: "text" as const, text }] };
}

export function createMcpProxy(
    toolName: McpToolName,
    upstream: McpUpstream,
    options: McpProxyOptions = {},
): Server {
    const env = options.env ?? process.env;
    const tool = mcpTools[toolName];
    const { adapter } = tool;
    const auditTool: McpAuditToolName = `${toolName}-mcp`;
    const server = new Server(
        { name: `agentiam-${toolName}`, version: "0.3.1" },
        { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        try {
            const result = await upstream.listTools(request.params, {
                signal: extra.signal,
            });
            return {
                tools: result.tools.filter((tool) =>
                    adapter.supportsTool(tool.name),
                ),
                ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            };
        } catch {
            throw new Error("MCP tool discovery failed");
        }
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const normalized = await adapter.normalize(request.params);
        let decision: "ALLOW" | "DENY" = "DENY";
        let reason = "unsupported MCP tool or arguments";
        if (normalized) {
            try {
                const loaded = await loadPolicy(env, options.cwd);
                const result = await evaluatePolicies(
                    loaded.policy,
                    loaded.directoryPolicies,
                    normalized,
                );
                decision = result.decision;
                reason = result.reason;
            } catch {
                reason = "policy evaluation failed";
            }
        }
        const safeName = adapter.supportsTool(request.params.name)
            ? request.params.name
            : "unsupported";
        const record: AuditRecord = {
            timestamp: new Date().toISOString(),
            capability: normalized ?? capability(tool.service, "unknown"),
            decision,
            tool: auditTool,
            arguments: [safeName],
            command: `${auditTool} ${safeName}`,
            policyPath: resolvePolicyPath(env),
            reason,
        };
        try {
            if (env.AGENTIAM_AUDIT_DIRECTORY) {
                await requestAuditWrite(env.AGENTIAM_AUDIT_DIRECTORY, record);
            } else {
                await appendAuditRecord(record, env);
            }
        } catch {
            return failure("Agent IAM denied the call: audit log unavailable");
        }
        if (decision === "DENY") {
            return failure(`Agent IAM denied the call: ${reason}`);
        }
        try {
            return await upstream.callTool(
                {
                    name: request.params.name,
                    arguments: request.params.arguments,
                },
                undefined,
                { signal: extra.signal },
            );
        } catch {
            return failure("MCP upstream call failed; no retry was made");
        }
    });
    return server;
}

export async function serveMcpProxy(
    toolName: McpToolName,
    upstreamTransport: Transport,
    options: McpProxyOptions = {},
    downstreamTransport: Transport = new StdioServerTransport(),
): Promise<void> {
    const upstream = new Client({
        name: `agentiam-${toolName}`,
        version: "0.3.1",
    });
    const server = createMcpProxy(toolName, upstream, options);
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
        stop = resolve;
    });
    upstream.onclose = stop;
    server.onclose = stop;
    process.stdin.once("end", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
        const connected = await Promise.race([
            upstream.connect(upstreamTransport).then(() => true),
            stopped.then(() => false),
        ]);
        if (!connected) return;
        await Promise.race([server.connect(downstreamTransport), stopped]);
        await stopped;
    } catch {
        throw new Error("MCP proxy connection failed");
    } finally {
        process.stdin.off("end", stop);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await Promise.allSettled([server.close(), upstream.close()]);
    }
}
