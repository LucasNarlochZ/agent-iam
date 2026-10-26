import { describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git.js";
import { gitService } from "../../src/services/git.js";
import { parsePolicy } from "../../src/policy/schema.js";
import { evaluatePolicy } from "../../src/policy/engine.js";

const adapter = new GitCliAdapter(
    async () => [],
    async () => "feature/local",
);

describe("granular Git permissions", () => {
    it.each([
        ["switch", "-c", "feature/auth"],
        ["switch", "--create", "feature/auth"],
        ["switch", "--create=feature/auth"],
        ["switch", "-cfeature/auth"],
        ["checkout", "-b", "feature/auth"],
        ["checkout", "-bfeature/auth", "main"],
        ["branch", "feature/auth"],
        ["branch", "feature/auth", "main"],
        ["branch", "--track=direct", "feature/auth", "origin/main"],
        ["branch", "--quiet", "feature/auth"],
        ["branch", "--create-reflog", "feature/auth"],
        ["branch", "--", "feature/auth"],
        ["-C", "/target", "switch", "-c", "feature/auth"],
    ])("normalizes branch creation %j", async (...args) => {
        expect(await adapter.normalize(args)).toEqual({
            service: "git",
            action: "create",
            canonical: "git.branch.create",
            constraints: { force: false },
        });
        expect(
            gitService.capabilityDefinition("git.branch.create"),
        ).toBeDefined();
    });

    it.each([
        ["switch", "-C", "feature/auth"],
        ["switch", "--force-create=feature/auth"],
        ["switch", "--force-create", "feature/auth"],
        ["switch", "-Cfeature/auth"],
        ["checkout", "-B", "feature/auth"],
        ["checkout", "-Bfeature/auth"],
        ["branch", "-f", "feature/auth"],
    ])("preserves forced branch creation %j", async (...args) => {
        const command = await adapter.normalize(args);
        expect(command.canonical).toBe("git.branch.create");
        expect(command.constraints).toEqual({ force: true });
    });

    it.each([
        ["branch"],
        ["branch", "--list", "feature/*"],
        ["branch", "-l", "feature/*"],
        ["branch", "-a"],
        ["branch", "-d", "feature/auth"],
        ["branch", "-D", "feature/auth"],
        ["branch", "-m", "feature/auth"],
        ["branch", "--edit-description", "feature/auth"],
        ["branch", "--set-upstream-to=origin/main", "feature/auth"],
        ["switch", "feature/auth"],
        ["checkout", "feature/auth"],
        ["checkout", "--", "-bfeature/auth"],
        ["checkout", "--conflict", "-bfeature/auth", "--", "file"],
    ])(
        "does not classify other operations as branch creation %j",
        async (...args) => {
            expect((await adapter.normalize(args)).canonical).toBe(
                `git.${args[0]}`,
            );
        },
    );

    it("authorizes all branch creation spellings with one permission", async () => {
        const policy = parsePolicy("allow:\n  git.branch.create: true\n");
        for (const args of [
            ["branch", "feature/auth"],
            ["switch", "-c", "feature/auth"],
            ["checkout", "-b", "feature/auth"],
        ]) {
            expect(
                (await evaluatePolicy(policy, await adapter.normalize(args)))
                    .decision,
            ).toBe("ALLOW");
        }
        expect(
            (
                await evaluatePolicy(
                    policy,
                    await adapter.normalize(["branch", "-d", "feature/auth"]),
                )
            ).decision,
        ).toBe("DENY");
    });

    it.each([
        ["worktree", "add"],
        ["worktree", "list"],
        ["worktree", "lock"],
        ["worktree", "move"],
        ["worktree", "prune"],
        ["worktree", "remove"],
        ["worktree", "repair"],
        ["worktree", "unlock"],
        ["remote", "add"],
        ["remote", "rename"],
        ["remote", "remove"],
        ["remote", "set-head"],
        ["remote", "set-branches"],
        ["remote", "get-url"],
        ["remote", "set-url"],
        ["remote", "show"],
        ["remote", "prune"],
        ["remote", "update"],
    ])("normalizes git %s %s", async (group, action) => {
        const command = await adapter.normalize([group, action]);
        expect(command.canonical).toBe(`git.${group}.${action}`);
        expect(
            gitService.capabilityDefinition(command.canonical),
        ).toBeDefined();
    });

    it("handles remote verbosity and the rm alias", async () => {
        expect(
            (await adapter.normalize(["remote", "-v", "show", "origin"]))
                .canonical,
        ).toBe("git.remote.show");
        expect(
            (await adapter.normalize(["remote", "rm", "origin"])).canonical,
        ).toBe("git.remote.remove");
        expect((await adapter.normalize(["remote", "-v"])).canonical).toBe(
            "git.remote",
        );
    });

    it.each([
        ["--force", "origin", "main"],
        ["-f", "origin", "HEAD:main"],
        ["origin", "+HEAD:refs/heads/main"],
        ["--force-with-lease", "origin", "HEAD:main"],
        ["--force-with-lease=main:abc", "origin", "HEAD:main"],
        ["--repo", "origin", "--force", "HEAD:main"],
    ])("normalizes force push %j", async (...args) => {
        expect(await adapter.normalize(["push", ...args])).toEqual({
            service: "git",
            action: "push",
            canonical: "git.push",
            constraints: { branches: ["main"], force: true },
        });
    });

    it("collects all destination branches and ordinary push force context", async () => {
        expect(
            (
                await adapter.normalize([
                    "push",
                    "origin",
                    "HEAD:main",
                    "dev:release",
                ])
            ).constraints,
        ).toEqual({ branches: ["main", "release"], force: false });
        expect((await adapter.normalize(["push"])).constraints).toEqual({
            branches: ["feature/local"],
            force: false,
        });
        expect(
            (await adapter.normalize(["push", "--all", "origin"])).constraints,
        ).toEqual({ force: false });
    });

    it("treats mirror pushes as forced updates without branch context", async () => {
        expect(
            (await adapter.normalize(["push", "--mirror", "origin"]))
                .constraints,
        ).toEqual({ force: true });
    });

    it.each([":", "HEAD:refs/tags/v1", "refs/heads/*:refs/heads/*"])(
        "omits unresolved branch context for %s",
        async (refspec) => {
            expect(
                (await adapter.normalize(["push", "origin", refspec]))
                    .constraints,
            ).toEqual({ force: false });
        },
    );

    it("enforces branch and force constraints together", async () => {
        const policy = parsePolicy(
            'allow:\n  git.push:\n    branches: [main]\n    force: ["false"]\n  git.worktree.list: true\n',
        );
        for (const [args, decision] of [
            [["push", "origin", "HEAD:main"], "ALLOW"],
            [["push", "-f", "origin", "HEAD:main"], "DENY"],
            [["push", "origin", "HEAD:dev"], "DENY"],
            [["worktree", "list"], "ALLOW"],
            [["worktree", "remove"], "DENY"],
        ] as const) {
            expect(
                (
                    await evaluatePolicy(
                        policy,
                        await adapter.normalize([...args]),
                    )
                ).decision,
            ).toBe(decision);
        }
    });

    it.each(["add", "commit"])("extracts force for git %s", async (action) => {
        expect(
            (await adapter.normalize([action, "--force"])).constraints?.force,
        ).toBe(true);
    });

    it("does not treat option values or literal filenames as force flags", async () => {
        expect(
            (await adapter.normalize(["commit", "-m", "--force"])).constraints
                ?.force,
        ).toBe(false);
        expect(
            (await adapter.normalize(["add", "--", "--force"])).constraints
                ?.force,
        ).toBe(false);
    });

    it("preserves force when only the lease is disabled", async () => {
        expect(
            (
                await adapter.normalize([
                    "push",
                    "--force",
                    "--no-force-with-lease",
                    "origin",
                    "main",
                ])
            ).constraints?.force,
        ).toBe(true);
    });

    it("extracts force for other Git commands", async () => {
        const command = await adapter.normalize([
            "worktree",
            "remove",
            "--force",
            "../other",
        ]);
        expect(command.constraints).toEqual({ force: true });
        expect(gitService.policyConstraints(command)).toEqual([
            { name: "force", values: ["true"], label: "force true" },
        ]);
    });
});
