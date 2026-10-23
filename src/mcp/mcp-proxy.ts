import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { appendAuditRecord, type AuditRecord } from "../audit/audit.js";
import { requestAuditWrite } from "../audit/audit-broker.js";
import {
    approvalChoice,
    persistApprovalDecision,
} from "../approvals/approval.js";
import { requestMcpApproval } from "./mcp-approval.js";
import { capability } from "../capability.js";
import { evaluatePolicies } from "../policy/engine.js";
import {
    loadPolicy,
    resolvePolicyPath,
    PolicyError,
} from "../policy/schema.js";
import {
    registry,
    type McpToolName,
    type McpAuditToolName,
} from "../registry/builtins.js";

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
    const tool = registry.getMcp(toolName);
    const { adapter } = tool;
    const auditTool: McpAuditToolName = `${toolName}-mcp`;
    let approvalQueue = Promise.resolve();
    const audit = async (record: AuditRecord) => {
        if (env.AGENTIAM_AUDIT_DIRECTORY) {
            await requestAuditWrite(env.AGENTIAM_AUDIT_DIRECTORY, record);
        } else {
            await appendAuditRecord(record, env);
        }
    };
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
        let reasonCode = "unsupported_capability";
        let policyPath = resolvePolicyPath(env);
        let globalPolicyPath = policyPath;
        let policyScope: "global" | "directory" | undefined;
        if (normalized) {
            try {
                const loaded = await loadPolicy(env, options.cwd);
                globalPolicyPath = loaded.path;
                const result = await evaluatePolicies(
                    loaded.policy,
                    loaded.directoryPolicies,
                    normalized,
                    {
                        global: loaded.path,
                        directories: loaded.directoryPolicyPaths,
                    },
                );
                decision = result.decision;
                reason = result.reason;
                reasonCode = result.reasonCode ?? "policy_error";
                policyPath = result.policyPath ?? policyPath;
                policyScope = result.policyScope;
            } catch (error) {
                reasonCode = "policy_error";
                reason =
                    error instanceof PolicyError
                        ? error.message.includes("ENOENT")
                            ? "policy file is missing; call denied before forwarding"
                            : error.message.includes("EACCES") ||
                                error.message.includes("EPERM")
                              ? "policy file is unreadable; call denied before forwarding"
                              : "policy is invalid; call denied before forwarding"
                        : "policy evaluation failed; call denied before forwarding";
            }
        }
        const safeName = adapter.supportsTool(request.params.name)
            ? request.params.name
            : "unsupported";
        const record: AuditRecord = {
            requestId: randomUUID(),
            timestamp: new Date().toISOString(),
            capability:
                normalized ?? capability(tool.service.service, "unknown"),
            decision,
            tool: auditTool,
            arguments: [safeName],
            command: `${auditTool} ${safeName}`,
            policyPath,
            reason,
            reasonCode,
            policyScope,
            event: "authorization",
        };
        try {
            await audit(record);
        } catch {
            return failure("Agent IAM denied the call: audit log unavailable");
        }
        if (
            normalized &&
            decision === "DENY" &&
            (reasonCode === "no_allow_rule" ||
                reasonCode === "constraint_mismatch") &&
            server.getClientCapabilities()?.elicitation?.form
        ) {
            const signal = AbortSignal.any([
                extra.signal,
                AbortSignal.timeout(300_000),
            ]);
            const approve = async () => {
                const context = {
                    cwd: options.cwd ?? process.cwd(),
                    globalPolicyPath,
                };
                let choice = "skip";
                let approvalPath = globalPolicyPath;
                let approvalReason =
                    "approval skipped or unavailable; call remains denied";
                let approvalCode = "approval_skip";
                try {
                    signal.throwIfAborted();
                    const selected = await requestMcpApproval(
                        normalized,
                        (request) =>
                            server.elicitInput(request, {
                                signal,
                                timeout: 300_000,
                                relatedRequestId: extra.requestId,
                            }),
                        context,
                    );
                    signal.throwIfAborted();
                    choice = approvalChoice(selected);
                    if (choice !== "skip") {
                        const loaded = await loadPolicy(env, options.cwd);
                        const current = await evaluatePolicies(
                            loaded.policy,
                            loaded.directoryPolicies,
                            normalized,
                        );
                        if (
                            current.decision === "DENY" &&
                            current.reasonCode !== "no_allow_rule" &&
                            current.reasonCode !== "constraint_mismatch"
                        ) {
                            throw new Error(
                                "policy no longer permits approval",
                            );
                        }
                        signal.throwIfAborted();
                        approvalPath = await persistApprovalDecision(
                            context,
                            normalized,
                            selected,
                        );
                    }
                    approvalCode =
                        choice === "allow-once"
                            ? "allow_once"
                            : `approval_${choice.replaceAll("-", "_")}`;
                    approvalReason =
                        choice === "allow-once"
                            ? "user approved this invocation once; policy unchanged"
                            : choice === "allow" || choice === "allow-context"
                              ? `allow rule saved to ${approvalPath}; call remains denied, retry required`
                              : choice === "deny" || choice === "deny-context"
                                ? `user saved an explicit deny rule to ${approvalPath}`
                                : approvalReason;
                    await audit({
                        ...record,
                        timestamp: new Date().toISOString(),
                        event: "approval",
                        approval: choice,
                        decision: choice === "allow-once" ? "ALLOW" : "DENY",
                        policyPath: approvalPath,
                        policyScope:
                            approvalPath === globalPolicyPath
                                ? "global"
                                : "directory",
                        reason: approvalReason,
                        reasonCode: approvalCode,
                    });
                    signal.throwIfAborted();
                    if (choice === "allow-once") decision = "ALLOW";
                    reason = approvalReason;
                } catch {
                    reason =
                        "approval failed, cancelled, or unavailable; call remains denied";
                    try {
                        await audit({
                            ...record,
                            timestamp: new Date().toISOString(),
                            event: "approval",
                            approval: choice,
                            decision: "DENY",
                            reason,
                            reasonCode: "approval_error",
                        });
                    } catch {
                        reason =
                            "approval audit log unavailable; call remains denied";
                    }
                }
            };
            const pending = approvalQueue.then(approve);
            approvalQueue = pending.catch(() => {});
            await pending;
        }
        if (decision === "DENY" || extra.signal.aborted) {
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
    process.stdin.read(0);
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
