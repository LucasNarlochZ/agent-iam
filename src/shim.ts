import {
    isCapabilityKey,
    resolvePolicyPath,
    loadPolicy,
} from "./policy/schema.js";
import { evaluatePolicies } from "./policy/engine.js";
import { appendAuditRecord, renderCommand } from "./audit.js";
import { requestAuditWrite } from "./audit-broker.js";
import { resolveExecutable, spawnInherited } from "./process.js";
import {
    persistApproval,
    requestApproval,
    type ApprovalChoice,
} from "./approval.js";
import type { CanonicalCapability } from "./capability.js";
import { cliTools, type ToolName } from "./tools.js";
import {
    requestBrokerApproval,
    requestFileApproval,
} from "./approval-broker.js";

export interface ShimOptions {
    tool: ToolName;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd?: string;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    promptForApproval?: (
        capability: CanonicalCapability,
    ) => Promise<ApprovalChoice>;
}

function write(
    stream: NodeJS.WritableStream | undefined,
    message: string,
): void {
    (stream ?? process.stderr).write(`${message}\n`);
}

export async function runShim(options: ShimOptions): Promise<number> {
    const capability = await cliTools[options.tool].adapter.normalize(
        options.args,
        options.env,
    );

    const policyPath = resolvePolicyPath(options.env);
    let decision: "ALLOW" | "DENY" = "DENY";
    let reason = "policy evaluation failed";
    let loadedPolicy: Awaited<ReturnType<typeof loadPolicy>> | undefined;
    try {
        const loaded = await loadPolicy(options.env, options.cwd);
        loadedPolicy = loaded;
        const result = await evaluatePolicies(
            loaded.policy,
            loaded.directoryPolicies,
            capability,
        );
        decision = result.decision;
        reason = result.reason;
    } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
    }
    const record = {
        timestamp: new Date().toISOString(),
        capability,
        decision,
        tool: options.tool,
        arguments: options.args,
        command: renderCommand(options.tool, options.args),
        policyPath,
        reason,
    } as const;
    try {
        if (options.env.AGENTIAM_AUDIT_DIRECTORY) {
            await requestAuditWrite(
                options.env.AGENTIAM_AUDIT_DIRECTORY,
                record,
            );
        } else {
            await appendAuditRecord(record, options.env);
        }
    } catch (error) {
        write(
            options.stderr,
            `[agentiam] DENY ${capability.canonical} (audit log unavailable): ${error instanceof Error ? error.message : String(error)}`,
        );
        return 126;
    }
    write(options.stderr, `[agentiam] ${decision} ${capability.canonical}`);
    if (decision === "DENY") {
        if (
            reason === "no matching allow rule" &&
            loadedPolicy &&
            isCapabilityKey(capability.canonical)
        ) {
            const parentPersistsApproval =
                options.promptForApproval === undefined &&
                Boolean(options.env.AGENTIAM_APPROVAL_DIRECTORY);
            const prompt =
                options.promptForApproval ??
                (async (requested: CanonicalCapability) => {
                    try {
                        if (options.env.AGENTIAM_APPROVAL_DIRECTORY) {
                            return await requestFileApproval(
                                options.env.AGENTIAM_APPROVAL_DIRECTORY,
                                requested,
                            );
                        }
                        if (options.env.AGENTIAM_APPROVAL_SOCKET) {
                            return await requestBrokerApproval(
                                options.env.AGENTIAM_APPROVAL_SOCKET,
                                requested,
                            );
                        }
                        return await requestApproval(requested);
                    } catch (error) {
                        write(
                            options.stderr,
                            `[agentiam] Approval broker unavailable: ${error instanceof Error ? error.message : String(error)}`,
                        );
                        return "skip" as const;
                    }
                });
            const choice = await prompt(capability);
            if (!parentPersistsApproval) {
                await persistApproval(
                    loadedPolicy.path,
                    loadedPolicy.policy,
                    capability,
                    choice,
                );
            }
            if (choice === "allow-once") {
                decision = "ALLOW";
                write(
                    options.stderr,
                    `[agentiam] Allowing ${capability.canonical} once; policy unchanged`,
                );
            } else if (choice === "allow" || choice === "allow-context") {
                write(
                    options.stderr,
                    `[agentiam] Saved allow rule to ${loadedPolicy.path}; retry the command to apply it`,
                );
            } else if (choice === "deny") {
                write(
                    options.stderr,
                    `[agentiam] Saved deny rule to ${loadedPolicy.path}`,
                );
            } else if (
                choice === "skip" &&
                options.env.AGENTIAM_NATIVE_APPROVAL_SOCKET
            ) {
                write(
                    options.stderr,
                    "[agentiam] Approval was skipped or unavailable. Check broker errors and the harness's native approval settings. The command remains denied.",
                );
            }
        }
        if (decision === "DENY") return 126;
    }
    try {
        const executable = await resolveExecutable(
            options.tool,
            options.env.AGENTIAM_ORIGINAL_PATH ?? options.env.PATH ?? "",
        );
        const result = await spawnInherited(
            executable,
            options.args,
            options.env,
        );
        return result.code ?? 128;
    } catch (error) {
        write(
            options.stderr,
            `[agentiam] ERROR ${error instanceof Error ? error.message : String(error)}`,
        );
        return 127;
    }
}
