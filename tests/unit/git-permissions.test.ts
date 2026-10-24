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
