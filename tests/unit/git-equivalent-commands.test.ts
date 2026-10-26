import { describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git.js";
import { gitService } from "../../src/services/git.js";
import { parsePolicy } from "../../src/policy/schema.js";
import { evaluatePolicy } from "../../src/policy/engine.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adapter = new GitCliAdapter(
    async () => [],
    async () => "main",
    async (target) => target === "feature/auth" || target === "-",
);

describe("equivalent Git commands", () => {
    it.each([
        ["restore", "file.txt"],
        ["restore", "--", "feature/auth"],
        ["restore", "--worktree", "file.txt"],
        ["restore", "-W", "file.txt"],
        ["restore", "--source", "HEAD", "--", "file.txt"],
        ["restore", "--source=HEAD", "file.txt"],
        ["restore", "-sHEAD", "file.txt"],
        ["restore", "--pathspec-from-file", "paths.txt"],
        ["checkout", "--", "file.txt"],
        ["checkout", "--quiet", "--", "file.txt"],
        ["checkout", "--ours", "--", "file.txt"],
        ["checkout", "--", "--force"],
    ])("normalizes worktree restoration %j", async (...args) => {
        expect(await adapter.normalize(args)).toEqual({
            service: "git",
            action: "worktree",
            canonical: "git.restore.worktree",
            constraints: { force: false },
        });
        expect(
            gitService.capabilityDefinition("git.restore.worktree"),
        ).toBeDefined();
    });

    it.each([
        ["restore", "--staged", "file.txt"],
        ["restore", "--staged", "--worktree", "file.txt"],
        ["restore", "-SW", "file.txt"],
        ["restore", "--source", "--staged", "file.txt"],
        ["restore", "--conflict", "--worktree", "--staged", "file.txt"],
        ["restore"],
        ["checkout", "HEAD", "--", "file.txt"],
        ["checkout", "feature/auth", "--", "file.txt"],
        ["checkout", "-b", "feature/new", "--", "file.txt"],
    ])(
        "does not grant index changes through worktree restoration %j",
        async (...args) => {
            expect((await adapter.normalize(args)).canonical).not.toBe(
                "git.restore.worktree",
            );
        },
    );

    it("authorizes equivalent worktree restores without allowing index changes", async () => {
        const policy = parsePolicy("allow:\n  git.restore.worktree: true\n");
        for (const [args, expected] of [
            [["restore", "file.txt"], "ALLOW"],
            [["checkout", "--", "file.txt"], "ALLOW"],
            [["checkout", "HEAD", "--", "file.txt"], "DENY"],
            [["restore", "--staged", "file.txt"], "DENY"],
            [["restore", "--staged", "--worktree", "file.txt"], "DENY"],
        ] as const) {
            expect(
                (
                    await evaluatePolicy(
                        policy,
                        await adapter.normalize([...args]),
                    )
                ).decision,
            ).toBe(expected);
        }
    });

    it("distinguishes local branches, tags, and filenames using Git", async () => {
        const repo = await mkdtemp(join(tmpdir(), "agentiam-checkout-"));
        const git = (...args: string[]) =>
            execFileSync("git", ["-C", repo, ...args]);
        git("init", "-b", "main");
        git(
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        );
        git("branch", "feature/auth");
        git("tag", "v1");
        await writeFile(join(repo, "file.txt"), "content");
        const realAdapter = new GitCliAdapter();
        for (const [target, canonical] of [
            ["feature/auth", "git.branch.switch"],
            ["file.txt", "git.checkout"],
            ["v1", "git.checkout"],
            ["HEAD", "git.checkout"],
        ]) {
            expect(
                (await realAdapter.normalize(["-C", repo, "checkout", target!]))
                    .canonical,
            ).toBe(canonical);
        }
        expect(
            (
                await realAdapter.normalize([
                    "-C",
                    join(repo, "missing"),
                    "checkout",
                    "feature/auth",
                ])
            ).canonical,
        ).toBe("git.checkout");
    });

    it.each([
        ["switch", "feature/auth"],
        ["checkout", "feature/auth"],
        ["switch", "--quiet", "feature/auth"],
        ["checkout", "--quiet", "feature/auth"],
        ["switch", "--", "feature/auth"],
        ["checkout", "feature/auth", "--"],
        ["switch", "-"],
        ["checkout", "-"],
    ])("normalizes branch switching %j", async (...args) => {
        expect(await adapter.normalize(args)).toEqual({
            service: "git",
            action: "switch",
            canonical: "git.branch.switch",
            constraints: { force: false },
        });
        expect(
            gitService.capabilityDefinition("git.branch.switch"),
        ).toBeDefined();
    });

    it.each([
        ["switch", "-f", "feature/auth"],
        ["checkout", "--force", "feature/auth"],
        ["switch", "--discard-changes", "feature/auth"],
    ])("preserves destructive switching context %j", async (...args) => {
        expect((await adapter.normalize(args)).constraints).toEqual({
            force: true,
        });
    });

    it.each([
        ["checkout", "file.txt"],
        ["checkout", "HEAD"],
        ["checkout", "--", "feature/auth"],
        ["checkout", "feature/auth", "--", "file.txt"],
        ["checkout", "--detach", "feature/auth"],
        ["switch", "--detach", "feature/auth"],
        ["switch", "--orphan", "new-branch"],
        ["switch", "-c", "new-branch"],
        ["checkout", "-b", "new-branch"],
        ["checkout"],
    ])(
        "does not mistake another operation for branch switching %j",
        async (...args) => {
            expect((await adapter.normalize(args)).canonical).not.toBe(
                "git.branch.switch",
            );
        },
    );

    it("looks up checkout targets in the selected repository", async () => {
        const calls: unknown[][] = [];
        const env = { PATH: "/custom" };
        const contextualAdapter = new GitCliAdapter(
            async () => [],
            async () => undefined,
            async (...args) => {
                calls.push(args);
                return true;
            },
        );
        expect(
            (
                await contextualAdapter.normalize(
                    ["-C", "/target", "checkout", "feature/auth"],
                    env,
                )
            ).canonical,
        ).toBe("git.branch.switch");
        expect(calls).toEqual([["feature/auth", env, ["-C", "/target"]]]);
    });

    it("authorizes both switching commands without granting creation or file checkout", async () => {
        const policy = parsePolicy(
            'allow:\n  git.branch.switch:\n    force: ["false"]\n',
        );
        for (const [args, expected] of [
            [["switch", "feature/auth"], "ALLOW"],
            [["checkout", "feature/auth"], "ALLOW"],
            [["switch", "--discard-changes", "feature/auth"], "DENY"],
            [["switch", "-c", "new-branch"], "DENY"],
            [["checkout", "--", "file.txt"], "DENY"],
        ] as const) {
            expect(
                (
                    await evaluatePolicy(
                        policy,
                        await adapter.normalize([...args]),
                    )
                ).decision,
            ).toBe(expected);
        }
    });
});
