import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistApproval, requestApproval } from "../../src/approval.js";
import { parsePolicy } from "../../src/policy/schema.js";

describe("interactive approval", () => {
    it("provides an interactive approval prompt", async () => {
        const approval = await import("../../src/approval.js");

        expect(approval.requestApproval).toBeTypeOf("function");
    });

    it("skips approval when no TTY is available", async () => {
        let asked = false;

        await expect(
            requestApproval(
                {
                    service: "git",
                    action: "push",
                    canonical: "git.push",
                    constraints: { branches: ["main"] },
                },
                {
                    isTTY: false,
                    ask: async () => {
                        asked = true;
                        return "1";
                    },
                },
            ),
        ).resolves.toBe("skip");
        expect(asked).toBe(false);
    });

    it("offers a context-specific allow when context is available", async () => {
        let message = "";

        await expect(
            requestApproval(
                {
                    service: "github",
                    action: "merge",
                    canonical: "github.pr.merge",
                    constraints: { repository: "owner/repo", pullRequest: 42 },
                },
                {
                    isTTY: true,
                    ask: async (question) => {
                        message = question;
                        return "2";
                    },
                },
            ),
        ).resolves.toBe("allow-context");
        expect(message).toContain("github.pr.merge");
        expect(message).toContain("Allow for repository owner/repo");
        expect(message).toContain("Explicitly deny");
        expect(message).toContain("Skip");
    });

    it("retries invalid answers and omits context when unavailable", async () => {
        const answers = ["invalid", "2"];
        const messages: string[] = [];

        await expect(
            requestApproval(
                {
                    service: "git",
                    action: "status",
                    canonical: "git.status",
                },
                {
                    isTTY: true,
                    ask: async (question) => {
                        messages.push(question);
                        return answers.shift() ?? "";
                    },
                },
            ),
        ).resolves.toBe("deny");
        expect(messages).toHaveLength(2);
        expect(messages[0]).not.toContain("current context");
    });

    it("adds a context to an existing constrained allow rule", async () => {
        const directory = await mkdtemp(join(tmpdir(), "agentiam-approval-"));
        const path = join(directory, "policy.yaml");
        const policy = {
            allow: {
                "github.pr.merge": { repos: ["owner/first"] },
            },
            deny: {},
        };
        await writeFile(path, "allow: {}\ndeny: {}\n");

        await persistApproval(
            path,
            policy,
            {
                service: "github",
                action: "merge",
                canonical: "github.pr.merge",
                constraints: { repository: "owner/second" },
            },
            "allow-context",
        );

        expect(parsePolicy(await readFile(path, "utf8"))).toEqual({
            allow: {
                "github.pr.merge": {
                    repos: ["owner/first", "owner/second"],
                },
            },
            deny: {},
        });
    });
});
