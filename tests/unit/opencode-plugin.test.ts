import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import plugin from "../../src/harnesses/opencode-plugin.js";
import type { CanonicalCapability } from "../../src/capability.js";
import {
    requestBrokerApproval,
    sendApprovalChoice,
} from "../../src/approvals/approval-broker.js";

afterEach(() => vi.unstubAllEnvs());

describe("OpenCode approval plugin", () => {
    async function setup(
        reject = false,
        capability: CanonicalCapability = {
            service: "git",
            action: "push",
            canonical: "git.push",
        },
    ) {
        const directory = await mkdtemp(join(tmpdir(), "agentiam-oc-"));
        vi.stubEnv(
            "AGENTIAM_NATIVE_APPROVAL_SOCKET",
            join(directory, "native.sock"),
        );
        vi.stubEnv("PATH", "/agentiam:/usr/bin");
        let shellHook: (event: any) => void;
        let permissionHook: (event: any) => void;
        const assert = vi.fn(async (_input: { metadata?: unknown }) => {
            if (reject) throw new Error("Rejected");
        });
        const tool = {
            execute: async (_input: unknown, _context: unknown) => {
                const event = { env: {} as NodeJS.ProcessEnv };
                shellHook(event);
                expect(event.env.PATH).toBe("/agentiam:/usr/bin");
                return requestBrokerApproval(
                    event.env.AGENTIAM_APPROVAL_SOCKET!,
                    capability,
                );
            },
        };
        await plugin.setup({
            shell: {
                hook: async (_name: string, callback: typeof shellHook) => {
                    shellHook = callback;
                },
            },
            permission: {
                assert,
                hook: async (
                    _name: string,
                    callback: typeof permissionHook,
                ) => {
                    permissionHook = callback;
                },
            },
            tool: {
                transform: async (transform: any) =>
                    transform({
                        list: () => [{ id: "shell" }],
                        update: (_id: string, update: any) => update(tool),
                    }),
            },
        } as unknown as Plugin.Context);
        return { tool, assert, permissionHook: () => permissionHook };
    }

    it("routes concurrent approvals to their invoking sessions", async () => {
        const { tool, assert } = await setup();
        expect(
            await Promise.all(
                ["ses_one", "ses_two"].map((sessionID) =>
                    tool.execute(
                        {},
                        {
                            sessionID,
                            agent: "build",
                            messageID: "msg",
                            id: "call",
                        },
                    ),
                ),
            ),
        ).toEqual(["allow", "allow"]);
        expect(
            assert.mock.calls.map(([input]: any) => input.sessionID).sort(),
        ).toEqual(["ses_one", "ses_two"]);
    });

    it("keeps a rejected native request denied", async () => {
        const { tool } = await setup(true);
        expect(await tool.execute({}, { sessionID: "ses_one" })).toBe("skip");
    });

    it("settles an approval when the tool is interrupted", async () => {
        const { tool, assert } = await setup();
        assert.mockImplementation(() => new Promise<void>(() => {}));
        const controller = new AbortController();
        const running = tool.execute(
            {},
            { sessionID: "ses_one", signal: controller.signal },
        );
        await vi.waitFor(() => expect(assert).toHaveBeenCalled());
        controller.abort();
        expect(await running).toBe("skip");
    });

    it("requires explicit approval for a policy change without overriding denies", async () => {
        const { permissionHook } = await setup();
        const event = { action: "agentiam.allow", effect: "allow" };
        permissionHook()(event);
        expect(event.effect).toBe("ask");
        event.effect = "deny";
        permissionHook()(event);
        expect(event.effect).toBe("deny");
    });

    it("exposes Agent IAM approval choices to the OpenCode TUI plugin", async () => {
        const { tool, assert } = await setup();
        await tool.execute({}, { sessionID: "ses_one" });
        expect(assert.mock.calls[0]![0].metadata).toMatchObject({
            agentiamApproval: {
                choices: [
                    { label: "Allow this capability", value: "allow" },
                    { label: "Allow once", value: "allow-once" },
                    { label: "Explicitly deny", value: "deny" },
                    { label: "Skip", value: "skip" },
                ],
            },
        });
    });

    it("returns the TUI's contextual approval choice to the shim", async () => {
        const { tool, assert } = await setup(false, {
            service: "git",
            action: "push",
            canonical: "git.push",
            constraints: { branches: ["main"] },
        });
        let resolveApproval!: () => void;
        assert.mockImplementation(
            () => new Promise<void>((resolve) => (resolveApproval = resolve)),
        );
        const execution = tool.execute({}, { sessionID: "ses_one" });
        await vi.waitFor(() => expect(assert).toHaveBeenCalled());
        const metadata = assert.mock.calls[0]![0].metadata as {
            agentiamApproval: { socket: string };
        };
        await sendApprovalChoice(
            metadata.agentiamApproval.socket,
            "allow-context",
        );
        resolveApproval();
        await expect(execution).resolves.toBe("allow-context");
    });
});
