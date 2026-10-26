import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
    persistApproval,
    approvalMessage,
    persistApprovalDecision,
    requestApproval,
    selectWithArrowKeys,
} from "../../src/approvals/approval.js";
import { parsePolicy } from "../../src/policy/schema.js";

describe("interactive approval", () => {
    it("escapes terminal controls in commands and normalized constraints", () => {
        const message = approvalMessage(
            {
                service: "git",
                action: "push",
                canonical: "git.push",
                constraints: { branches: ["dev\u009b2J", "main\nspoof"] },
            },
            {
                cwd: "/project",
                globalPolicyPath: "/policy.yaml",
                command: "git push\u001b[2J\norigin dev",
            },
        );
        expect(message).toContain("Command: git push\\u001b[2J\\norigin dev");
        expect(message).toContain(
            "Constraints: branches:dev\\u009b2J, main\\nspoof",
        );
        expect(message).not.toMatch(/[\u001b\u009b]/);
    });

    it("explicitly reports when there are no normalized constraints", () => {
        expect(
            approvalMessage({
                service: "git",
                action: "status",
                canonical: "git.status",
            }),
        ).toBe("[agentiam] git.status was denied.\nConstraints: none");
    });

    it("shows the complete command and every normalized constraint before the decision", async () => {
        let message = "";
        await requestApproval(
            {
                service: "git",
                action: "push",
                canonical: "git.push",
                constraints: {
                    branches: ["dev"],
                    remote: "origin",
                    force: false,
                },
            },
            {
                isTTY: true,
                context: {
                    cwd: process.cwd(),
                    globalPolicyPath: "/nonexistent/policy.yaml",
                    command: 'git push origin dev --push-option="hello world"',
                },
                select: async (prompt) => {
                    message = prompt;
                    return "allow-once";
                },
            },
        );
        expect(message).toBe(
            '[agentiam] git.push was denied.\nCommand: git push origin dev --push-option="hello world"\nConstraints: branches:dev, remote:origin, force:false',
        );
    });

    it("provides an interactive approval prompt", async () => {
        const approval = await import("../../src/approvals/approval.js");

        expect(approval.requestApproval).toBeTypeOf("function");
        expect(approval.selectWithArrowKeys).toBeTypeOf("function");
    });

    it("skips approval when no TTY is available", async () => {
        let selected = false;

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
                    select: async () => {
                        selected = true;
                        return "allow";
                    },
                },
            ),
        ).resolves.toBe("skip");
        expect(selected).toBe(false);
    });

    it("asks for the decision before offering an action scope", async () => {
        const prompts: string[][] = [];

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
                    select: async (prompt, choices) => {
                        prompts.push([
                            prompt,
                            ...choices.map(({ label }) => label),
                        ]);
                        if (prompts.length === 1) return "allow";
                        return choices[1]!.value;
                    },
                },
            ),
        ).resolves.toMatchObject({ choice: "allow-context", scope: ["repos"] });
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toEqual([
            "[agentiam] github.pr.merge was denied.\nConstraints: repository:owner/repo, pullRequest:42",
            "Allow permanently",
            "Allow once",
            "Deny permanently",
            "Skip",
        ]);
        expect(prompts[1]).toContain("Only for repository owner/repo");
    });

    it("omits context when unavailable", async () => {
        let labels: string[] = [];

        await expect(
            requestApproval(
                {
                    service: "git",
                    action: "status",
                    canonical: "git.status",
                },
                {
                    isTTY: true,
                    select: async (_prompt, choices) => {
                        labels = choices.map(({ label }) => label);
                        return choices.find(({ value }) => value === "deny")!
                            .value;
                    },
                },
            ),
        ).resolves.toBe("deny");
        expect(labels).toEqual([
            "Allow permanently",
            "Allow once",
            "Deny permanently",
            "Skip",
        ]);
    });

    it("offers allow once without a policy rule", async () => {
        const { approvalOptions } =
            await import("../../src/approvals/approval.js");

        expect(
            approvalOptions({
                service: "git",
                action: "status",
                canonical: "git.status",
            }),
        ).toContainEqual({ label: "Allow once", value: "allow-once" });
    });

    it.each(["allow", "deny"] as const)(
        "asks at most three questions for a permanent %s",
        async (choice) => {
            const root = await mkdtemp(
                join(tmpdir(), "agentiam-approval-scope-"),
            );
            const cwd = join(root, "project");
            const home = join(root, "home");
            const path = join(cwd, ".agentiam", "policy.yaml");
            await mkdir(join(cwd, ".agentiam"), { recursive: true });
            await writeFile(path, "allow: {}\ndeny: {}\n");
            const prompts: string[][] = [];
            const result = await requestApproval(
                {
                    service: "github",
                    action: "merge",
                    canonical: "github.pr.merge",
                    constraints: { repository: "owner/repo" },
                },
                {
                    isTTY: true,
                    cwd,
                    env: { HOME: home },
                    select: async (message, choices) => {
                        prompts.push([
                            message,
                            ...choices.map(({ label }) => label),
                        ]);
                        return prompts.length === 1
                            ? choice
                            : choices[1]!.value;
                    },
                },
            );
            expect(result).toEqual({
                choice: `${choice}-context`,
                scope: ["repos"],
                policyPath: path,
            });
            expect(prompts).toHaveLength(3);
            expect(prompts[2]).toContain(
                `Global policy (${join(home, ".agentiam", "policy.yaml")})`,
            );
            expect(prompts[2]).toContain(`Local policy (${path})`);
        },
    );

    it.each(["allow-once", "skip"] as const)(
        "does not ask follow-up questions for %s",
        async (choice) => {
            let questions = 0;
            expect(
                await requestApproval(
                    {
                        service: "github",
                        action: "merge",
                        canonical: "github.pr.merge",
                        constraints: { repository: "owner/repo" },
                    },
                    {
                        isTTY: true,
                        select: async () => {
                            questions++;
                            return choice;
                        },
                    },
                ),
            ).toBe(choice);
            expect(questions).toBe(1);
        },
    );

    it("cancels the entire decision when a follow-up is skipped", async () => {
        let questions = 0;
        expect(
            await requestApproval(
                {
                    service: "github",
                    action: "merge",
                    canonical: "github.pr.merge",
                    constraints: { repository: "owner/repo" },
                },
                {
                    isTTY: true,
                    select: async () => (++questions === 1 ? "deny" : "skip"),
                },
            ),
        ).toBe("skip");
        expect(questions).toBe(2);
    });

    it("persists a scoped deny without denying other repositories", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "agentiam-approval-deny-"),
        );
        const path = join(directory, "policy.yaml");
        const policy = { allow: {}, deny: {} };
        await persistApproval(
            path,
            policy,
            {
                service: "github",
                action: "merge",
                canonical: "github.pr.merge",
                constraints: { repository: "owner/repo" },
            },
            { choice: "deny-context", scope: ["repos"] },
        );
        expect(parsePolicy(await readFile(path, "utf8"))).toEqual({
            allow: {},
            deny: { "github.pr.merge": { repos: ["owner/repo"] } },
        });
    });

    it("selects an approval choice with arrow keys", async () => {
        const input = new PassThrough() as unknown as NodeJS.ReadStream;
        const output = new PassThrough();
        Object.defineProperty(input, "isRaw", {
            value: false,
            writable: true,
        });
        input.setRawMode = (mode) => {
            input.isRaw = mode;
            return input;
        };
        let rendered = "";
        output.on("data", (chunk) => {
            rendered += chunk.toString();
        });

        const selection = selectWithArrowKeys(
            "Choose",
            [
                { label: "Allow", value: "allow" },
                { label: "Deny", value: "deny" },
                { label: "Skip", value: "skip" },
            ],
            input,
            output,
        );
        input.write("\u001B[B\r");

        await expect(selection).resolves.toBe("deny");
        expect(input.isRaw).toBe(false);
        expect(rendered).toContain("❯ Allow");
        expect(rendered).toContain("❯ Deny");
    });

    it("cancels a follow-up with Escape even when it has no Skip option", async () => {
        const input = new PassThrough() as unknown as NodeJS.ReadStream;
        input.setRawMode = () => input;
        const selected = selectWithArrowKeys(
            "Scope",
            [{ label: "All contexts", value: "all" }],
            input,
            new PassThrough(),
        );
        input.emit("keypress", "", { name: "escape" });
        expect(await selected).toBe("skip");
    });

    it("asks only for the policy destination when an action has no scope controls", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agentiam-approval-target-"));
        await mkdir(join(cwd, ".agentiam"));
        await writeFile(join(cwd, ".agentiam/policy.yaml"), "allow: {}\n");
        const globalPolicyPath = join(cwd, "home/.agentiam/policy.yaml");
        const prompts: string[] = [];
        expect(
            await requestApproval(
                { service: "git", action: "status", canonical: "git.status" },
                {
                    isTTY: true,
                    context: { cwd, globalPolicyPath },
                    select: async (message, choices) => {
                        prompts.push(message);
                        return prompts.length === 1
                            ? "allow"
                            : choices[0]!.value;
                    },
                },
            ),
        ).toEqual({ choice: "allow", policyPath: globalPolicyPath });
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toBe("Save the rule in which policy?");
    });

    it("does not offer ancestor directory policies as the current local policy", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "agentiam-approval-ancestor-"),
        );
        await mkdir(join(root, ".agentiam"));
        await mkdir(join(root, "nested"));
        await writeFile(join(root, ".agentiam/policy.yaml"), "allow: {}\n");
        let questions = 0;
        expect(
            await requestApproval(
                { service: "git", action: "status", canonical: "git.status" },
                {
                    isTTY: true,
                    cwd: join(root, "nested"),
                    env: { HOME: join(root, "home") },
                    select: async () => {
                        questions++;
                        return "allow";
                    },
                },
            ),
        ).toBe("allow");
        expect(questions).toBe(1);
    });

    it("allows selecting all action contexts without persisting constraints", async () => {
        let questions = 0;
        expect(
            await requestApproval(
                {
                    service: "git",
                    action: "push",
                    canonical: "git.push",
                    constraints: { branches: ["main"] },
                },
                {
                    isTTY: true,
                    select: async () => (++questions === 1 ? "deny" : "all"),
                },
            ),
        ).toBe("deny");
        expect(questions).toBe(2);
    });

    it("rejects a policy target outside the offered global and local policies", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agentiam-approval-invalid-"));
        const path = join(cwd, "other.yaml");
        await writeFile(path, "allow: {}\n");
        await expect(
            persistApprovalDecision(
                { cwd, globalPolicyPath: join(cwd, ".agentiam/policy.yaml") },
                {
                    service: "git",
                    action: "status",
                    canonical: "git.status",
                },
                { choice: "allow", policyPath: path },
            ),
        ).rejects.toThrow("Invalid approval policy target");
        expect(await readFile(path, "utf8")).toBe("allow: {}\n");
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
