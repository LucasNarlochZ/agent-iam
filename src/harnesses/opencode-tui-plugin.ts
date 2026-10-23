import type { Plugin } from "@opencode/plugin/tui";
import type { ApprovalChoice } from "../approvals/approval.js";
import { sendApprovalChoice } from "../approvals/approval-broker.js";

type AgentIAMChoice = {
    label: string;
    value: ApprovalChoice;
};

type AgentIAMApproval = {
    socket: string;
    choices: AgentIAMChoice[];
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
                !Array.isArray(approval.choices) ||
                active.has(request.id)
            ) {
                return;
            }
            active.add(request.id);
            void (async () => {
                let choice: ApprovalChoice = "skip";
                try {
                    choice =
                        (await context.ui.dialog.select({
                            title: `Agent IAM approval: ${request.resources.join(", ")}`,
                            options: approval.choices.map(
                                ({ label, value }) => ({
                                    title: label,
                                    value,
                                }),
                            ),
                        })) ?? "skip";
                    await sendApprovalChoice(approval.socket, choice);
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
