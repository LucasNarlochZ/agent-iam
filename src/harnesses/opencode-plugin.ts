import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { unlink } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";
import {
    startApprovalBroker,
    startApprovalChoiceChannel,
} from "../approval-broker.js";
import { approvalOptions } from "../approval.js";

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
                    "Save a permanent Agent IAM allow rule, then retry the denied command.";
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
                            async (capability) => {
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
                                            result.choice === "deny" ||
                                            result.choice === "skip"
                                            ? result.choice
                                            : "skip";
                                    }
                                    return "allowed" in result && result.allowed
                                        ? "allow"
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
