import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import plugin from "../../src/opencode-plugin.js";
import { requestBrokerApproval } from "../../src/approval-broker.js";

afterEach(() => vi.unstubAllEnvs());

describe("OpenCode approval plugin", () => {
    async function setup(reject = false) {
        const directory = await mkdtemp(join(tmpdir(), "agentiam-oc-"));
        vi.stubEnv(
            "AGENTIAM_NATIVE_APPROVAL_SOCKET",
            join(directory, "native.sock"),
        );
        vi.stubEnv("PATH", "/agentiam:/usr/bin");
        let shellHook: (event: any) => void;
        let permissionHook: (event: any) => void;
        const assert = vi.fn(async () => {
            if (reject) throw new Error("Rejected");
        });
        const tool = {
            execute: async (_input: unknown, _context: unknown) => {
                const event = { env: {} as NodeJS.ProcessEnv };
                shellHook(event);
                expect(event.env.PATH).toBe("/agentiam:/usr/bin");
                return requestBrokerApproval(
                    event.env.AGENTIAM_APPROVAL_SOCKET!,
                    {
                        service: "git",
                        action: "push",
                        canonical: "git.push",
                    },
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
});
