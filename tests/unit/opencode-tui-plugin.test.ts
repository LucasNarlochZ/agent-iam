import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin/tui";
import plugin from "../../src/harnesses/opencode-tui-plugin.js";
import { startApprovalChoiceChannel } from "../../src/approvals/approval-broker.js";

describe("OpenCode TUI approval plugin", () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
        ["allow", "once"],
        ["allow-context", "once"],
        ["allow-once", "once"],
        ["deny", "reject"],
        ["deny-context", "reject"],
        ["skip", "reject"],
    ] as const)("forwards %s and replies %s", async (choice, decision) => {
        const directory = await mkdtemp(join(tmpdir(), "agentiam-tui-"));
        const path = join(directory, "choice.sock");
        const channel = await startApprovalChoiceChannel(path);
        let permissionAsked: ((event: any) => void) | undefined;
        const reply = vi.fn(async () => {});
        const contextual = choice.endsWith("-context");
        const select = vi
            .fn()
            .mockResolvedValueOnce(contextual ? choice.split("-")[0] : choice)
            .mockResolvedValueOnce("branches");
        const cleanup = plugin.setup({
            data: {
                on: (_type: string, callback: typeof permissionAsked) => {
                    permissionAsked = callback;
                    return () => {};
                },
            },
            ui: { dialog: { select } },
            client: { permission: { reply } },
        } as unknown as Plugin.Context);

        permissionAsked!({
            data: {
                id: "per_one",
                sessionID: "ses_one",
                action: "agentiam.allow",
                resources: ["git.push"],
                metadata: {
                    agentiamApproval: {
                        socket: path,
                        choices: [{ label: "Choice", value: choice }],
                        plan: {
                            message: "Agent IAM approval: git.push",
                            scopes: contextual
                                ? [
                                      {
                                          label: "Only main",
                                          value: "branches",
                                          constraints: ["branches"],
                                      },
                                  ]
                                : [],
                            policies: [],
                        },
                    },
                },
            },
        });

        await expect(channel.choice).resolves.toEqual(
            contextual ? { choice, scope: ["branches"] } : choice,
        );
        await vi.waitFor(() =>
            expect(reply).toHaveBeenCalledWith({
                sessionID: "ses_one",
                requestID: "per_one",
                decision,
            }),
        );
        expect(select).toHaveBeenCalledWith({
            title: "Agent IAM approval: git.push",
            options: [
                { title: "Allow permanently", value: "allow" },
                { title: "Allow once", value: "allow-once" },
                { title: "Deny permanently", value: "deny" },
                { title: "Skip", value: "skip" },
            ],
        });
        if (typeof cleanup === "function") await cleanup();
        await channel.close();
    });
});
