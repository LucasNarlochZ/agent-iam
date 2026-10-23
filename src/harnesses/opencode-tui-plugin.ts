import type { Plugin } from "@opencode/plugin/tui";
import {
    approvalChoice,
    selectApproval,
    type ApprovalDecision,
    type ApprovalPlan,
} from "../approvals/approval.js";
import { sendApprovalChoice } from "../approvals/approval-broker.js";

type AgentIAMApproval = {
    socket: string;
    plan: ApprovalPlan;
};

const agentIAMPlugin: Plugin.Definition = {
    id: "agentiam.tui",
    setup(context) {
        const active = new Set<string>();
        return context.data.on("permission.asked", (event) => {
            const request = event.data;
            const approval = request.metadata?.agentiamApproval as
                AgentIAMApproval | undefined;
            if (
                request.action !== "agentiam.allow" ||
                !approval?.socket ||
                !approval.plan ||
                active.has(request.id)
            ) {
                return;
            }
            active.add(request.id);
            void (async () => {
                let selected: ApprovalDecision = "skip";
                try {
                    selected = await selectApproval(
                        {
                            ...approval.plan,
                            message: `Agent IAM approval: ${request.resources.join(", ")}`,
                        },
                        async (title, choices) =>
                            (await context.ui.dialog.select({
                                title,
                                options: choices.map(({ label, value }) => ({
                                    title: label,
                                    value,
                                })),
                            })) ?? "skip",
                    );
                    const choice = approvalChoice(selected);
                    await sendApprovalChoice(approval.socket, selected);
                    await context.client.permission.reply({
                        sessionID: request.sessionID,
                        requestID: request.id,
                        decision:
                            choice === "allow" ||
                            choice === "allow-context" ||
                            choice === "allow-once"
                                ? "once"
                                : "reject",
                    });
                } catch {
                    await context.client.permission
                        .reply({
                            sessionID: request.sessionID,
                            requestID: request.id,
                            decision: "reject",
                        })
                        .catch(() => {});
                } finally {
                    active.delete(request.id);
                }
            })();
        });
    },
};

export default agentIAMPlugin;
