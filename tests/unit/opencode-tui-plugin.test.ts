import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin/tui";
import plugin from "../../src/harnesses/opencode-tui-plugin.js";
import { startApprovalChoiceChannel } from "../../src/approval-broker.js";

describe("OpenCode TUI approval plugin", () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
        ["allow", "once"],
        ["allow-context", "once"],
        ["allow-once", "once"],
        ["deny", "reject"],
        ["skip", "reject"],
    ] as const)("forwards %s and replies %s", async (choice, decision) => {
        const directory = await mkdtemp(join(tmpdir(), "agentiam-tui-"));
        const path = join(directory, "choice.sock");
        const channel = await startApprovalChoiceChannel(path);
        let permissionAsked: ((event: any) => void) | undefined;
        const reply = vi.fn(async () => {});
        const select = vi.fn(async () => choice);
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
                    },
                },
            },
        });

        await expect(channel.choice).resolves.toBe(choice);
        await vi.waitFor(() =>
            expect(reply).toHaveBeenCalledWith({
                sessionID: "ses_one",
                requestID: "per_one",
                decision,
            }),
        );
        expect(select).toHaveBeenCalledWith({
            title: "Agent IAM approval: git.push",
            options: [{ title: "Choice", value: choice }],
        });
        if (typeof cleanup === "function") await cleanup();
        await channel.close();
    });
});
