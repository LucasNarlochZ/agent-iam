import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { unlink } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";
import {
    startApprovalBroker,
    startApprovalChoiceChannel,
} from "../approvals/approval-broker.js";
import {
    approvalChoice,
    approvalOptions,
    createApprovalPlan,
} from "../approvals/approval.js";
import {
    proxyMcpCommand,
    mcpProxyEnvironment,
    checkMcpUrl,
    warnUnproxiedMcp,
} from "../mcp/mcp-configuration.js";

const environmentKeys = [
    "PATH",
    "ZDOTDIR",
    "BASH_ENV",
    "ENV",
    "AGENTIAM_NODE",
    "AGENTIAM_ENTRYPOINT",
    "AGENTIAM_ORIGINAL_PATH",
] as const;

export default Plugin.define({
    id: "agentiam",
    async setup(ctx) {
        if (process.env.AGENTIAM_NODE && process.env.AGENTIAM_ENTRYPOINT) {
            const mcpEnv = {
                ...process.env,
                AGENTIAM_MCP_POLICY_CWD: ctx.location.directory,
            };
            await ctx.mcp.transform((editor) => {
                for (const [name, server] of editor.list()) {
                    if (server.disabled) continue;
                    if (server.type === "local") {
                        const command = proxyMcpCommand(server.command, mcpEnv);
                        if (!command) {
                            warnUnproxiedMcp();
                            continue;
                        }
                        editor.update(name, (draft) => {
                            if (draft.type !== "local") return;
                            draft.command = command;
                            draft.environment = {
                                ...draft.environment,
                                ...mcpProxyEnvironment(mcpEnv),
                            };
                        });
                    } else {
                        try {
                            checkMcpUrl(server.url);
                            warnUnproxiedMcp();
                        } catch {
                            editor.update(name, (draft) => {
                                draft.disabled = true;
                            });
                            process.stderr.write(
                                "[agentiam] Disabled a registered HTTP MCP server: only stdio proxying is supported\n",
                            );
                        }
                    }
                }
            });
        }
        const nativeSocket = process.env.AGENTIAM_NATIVE_APPROVAL_SOCKET;
        if (!nativeSocket) return;
        const sockets = new AsyncLocalStorage<string>();
        const environment = Object.fromEntries(
            environmentKeys.map((key) => [key, process.env[key]]),
        );
        await ctx.permission.hook("evaluate", (event) => {
            if (event.action === "agentiam.allow" && event.effect !== "deny") {
                event.effect = "ask";
                event.message =
                    "Choose an Agent IAM approval decision, action scope, and policy destination.";
            }
        });
        await ctx.shell.hook("create.before", (event) => {
            Object.assign(event.env, environment);
            event.env.AGENTIAM_APPROVAL_SOCKET = sockets.getStore();
        });
        await ctx.tool.transform((editor) => {
            for (const { id } of editor.list()) {
                editor.update(id, (tool) => {
                    const execute = tool.execute;
                    tool.execute = async (input, context) => {
                        const socket = join(
                            dirname(nativeSocket),
                            `${randomUUID().slice(0, 8)}.sock`,
                        );
                        const broker = await startApprovalBroker(
                            socket,
                            async (capability, approvalContext) => {
                                const signal = context.signal;
                                if (signal?.aborted) return "skip";
                                const choicePath = join(
                                    dirname(nativeSocket),
                                    `${randomUUID().slice(0, 8)}.choice.sock`,
                                );
                                const choiceChannel =
                                    await startApprovalChoiceChannel(
                                        choicePath,
                                    );
                                let onAbort = () => {};
                                const aborted = new Promise<"skip">(
                                    (resolve) => {
                                        onAbort = () => resolve("skip");
                                        signal?.addEventListener(
                                            "abort",
                                            onAbort,
                                            { once: true },
                                        );
                                    },
                                );
                                try {
                                    const approval = ctx.permission
                                        .assert({
                                            sessionID: context.sessionID,
                                            agent: context.agent,
                                            source: {
                                                type: "tool",
                                                messageID: context.messageID,
                                                id: context.id,
                                            },
                                            action: "agentiam.allow",
                                            resources: [capability.canonical],
                                            save: [],
                                            metadata: {
                                                capability,
                                                persistent: true,
                                                agentiamApproval: {
                                                    socket: choicePath,
                                                    plan: await createApprovalPlan(
                                                        capability,
                                                        approvalContext,
                                                    ),
                                                    choices:
                                                        approvalOptions(
                                                            capability,
                                                        ),
                                                },
                                            },
                                        })
                                        .then(
                                            () => true,
                                            () => false,
                                        );
                                    const result = await Promise.race([
                                        choiceChannel.choice.then((choice) => ({
                                            choice,
                                        })),
                                        approval.then((allowed) => ({
                                            allowed,
                                        })),
                                        aborted.then(() => ({ aborted: true })),
                                    ]);
                                    if ("choice" in result) {
                                        const allowed = await Promise.race([
                                            approval,
                                            aborted.then(() => false),
                                        ]);
                                        return allowed ||
                                            approvalChoice(result.choice) ===
                                                "deny" ||
                                            approvalChoice(result.choice) ===
                                                "deny-context" ||
                                            approvalChoice(result.choice) ===
                                                "skip"
                                            ? result.choice
                                            : "skip";
                                    }
                                    return "allowed" in result && result.allowed
                                        ? "allow-once"
                                        : "skip";
                                } finally {
                                    await choiceChannel.close();
                                    await unlink(choicePath).catch(
                                        (error: NodeJS.ErrnoException) => {
                                            if (error.code !== "ENOENT")
                                                throw error;
                                        },
                                    );
                                    signal?.removeEventListener(
                                        "abort",
                                        onAbort,
                                    );
                                }
                            },
                        );
                        try {
                            return await sockets.run(socket, () =>
                                execute(input, context),
                            );
                        } finally {
                            await broker.close();
                            await unlink(socket).catch(
                                (error: NodeJS.ErrnoException) => {
                                    if (error.code !== "ENOENT") throw error;
                                },
                            );
                        }
                    };
                });
            }
        });
    },
});
