import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git.js";
import { GithubCliAdapter } from "../../src/adapters/gh.js";

describe("command adapters", () => {
    it("normalizes AWS service operations and leading global options", async () => {
        const { AwsCliAdapter } = await import("../../src/adapters/aws.js");
        const awsAdapter = new AwsCliAdapter();

        await expect(
            awsAdapter.normalize([
                "--profile",
                "development",
                "sts",
                "get-caller-identity",
            ]),
        ).resolves.toMatchObject({
            service: "aws",
            action: "get-caller-identity",
            canonical: "aws.sts.get-caller-identity",
        });
        await expect(
            awsAdapter.normalize(["--region=us-east-1", "s3", "cp"]),
        ).resolves.toMatchObject({
            canonical: "aws.s3.cp",
        });
        await expect(
            awsAdapter.normalize([
                "--no-cli-pager",
                "ec2",
                "describe-instances",
            ]),
        ).resolves.toMatchObject({
            canonical: "aws.ec2.describe-instances",
        });
        await expect(awsAdapter.normalize([])).resolves.toMatchObject({
            canonical: "aws.unknown.unknown",
        });
        await expect(
            awsAdapter.normalize(["--profile"]),
        ).resolves.toMatchObject({
            canonical: "aws.unknown.unknown",
        });
    });

    it("normalizes git commands", async () => {
        const gitAdapter = new GitCliAdapter(
            async () => ["src/policy.ts"],
            async () => "main",
        );
        expect(
            (await gitAdapter.normalize(["commit", "-m", "fix"])).canonical,
        ).toBe("git.commit");
        expect(
            (await gitAdapter.normalize(["commit", "-m", "fix"])).constraints,
        ).toEqual({ paths: ["src/policy.ts"], branches: ["main"] });
        expect((await gitAdapter.normalize(["remote", "-v"])).canonical).toBe(
            "git.remote",
        );
        expect(
            (
                await gitAdapter.normalize([
                    "config",
                    "--get",
                    "remote.origin.url",
                ])
            ).canonical,
        ).toBe("git.config");
        expect(
            (await gitAdapter.normalize(["symbolic-ref", "--short", "HEAD"]))
                .canonical,
        ).toBe("git.symbolic-ref");
        expect(
            (
                await gitAdapter.normalize([
                    "-C",
                    "/repo",
                    "push",
                    "origin",
                    "main",
                ])
            ).canonical,
        ).toBe("git.push");
        expect(
            (await gitAdapter.normalize(["push", "origin", "main"]))
                .constraints,
        ).toEqual({ branches: ["main"] });
        expect(
            (await gitAdapter.normalize(["--git-dir=/repo/.git", "status"]))
                .canonical,
        ).toBe("git.status");
        expect((await gitAdapter.normalize(["-C"])).canonical).toBe(
            "git.unknown",
        );
    });

    it.each(["add", "commit"])(
        "includes the current branch for git %s",
        async (action) => {
            const adapter = new GitCliAdapter(
                async () => [],
                async () => "feature/work",
            );
            await expect(adapter.normalize([action])).resolves.toMatchObject({
                constraints: { branches: ["feature/work"] },
            });
        },
    );

    it.each(["add", "commit"])(
        "omits unavailable branch context for git %s",
        async (action) => {
            const adapter = new GitCliAdapter(
                async () => [],
                async () => undefined,
            );
            expect(
                (await adapter.normalize([action])).constraints,
            ).toBeUndefined();
        },
    );

    it("keeps staged paths when the commit branch is unavailable", async () => {
        const adapter = new GitCliAdapter(
            async () => ["safe.txt"],
            async () => undefined,
        );
        expect((await adapter.normalize(["commit"])).constraints).toEqual({
            paths: ["safe.txt"],
        });
    });

    it.each(["add", "commit"])(
        "uses leading Git options to read the branch for git %s",
        async (action) => {
            const bin = await mkdtemp(join(tmpdir(), "agentiam-git-context-"));
            const git = join(bin, "git");
            await writeFile(
                git,
                '#!/bin/sh\nif [ "$1" = "-C" ] && [ "$2" = "/target" ] && [ "$3" = "branch" ]; then printf "feature/target\\n"; fi\n',
            );
            await chmod(git, 0o755);
            await expect(
                new GitCliAdapter().normalize(["-C", "/target", action], {
                    PATH: bin,
                    AGENTIAM_ORIGINAL_PATH: bin,
                }),
            ).resolves.toMatchObject({
                constraints: { branches: ["feature/target"] },
            });
        },
    );

    it("normalizes gh commands", async () => {
        const ghAdapter = new GithubCliAdapter();
        expect(
            (await ghAdapter.normalize(["pr", "create", "--fill"])).canonical,
        ).toBe("github.pr.create");
        expect(
            (
                await ghAdapter.normalize([
                    "--repo",
                    "owner/repo",
                    "pr",
                    "merge",
                    "42",
                ])
            ).canonical,
        ).toBe("github.pr.merge");
        expect(
            (
                await ghAdapter.normalize([
                    "--repo",
                    "owner/repo",
                    "pr",
                    "merge",
                    "42",
                ])
            ).constraints,
        ).toEqual({ repository: "owner/repo", pullRequest: 42 });
        expect((await ghAdapter.normalize(["auth"])).canonical).toBe(
            "github.auth",
        );
        expect((await ghAdapter.normalize([])).canonical).toBe(
            "github.unknown",
        );
    });

    it("resolves the repository from the Git origin when --repo is absent", async () => {
        const bin = await mkdtemp(join(tmpdir(), "agentiam-git-bin-"));
        const git = join(bin, "git");
        await writeFile(
            git,
            "#!/bin/sh\nprintf 'git@github.com:owner/repo.git\\n'\n",
        );
        await chmod(git, 0o755);
        const ghAdapter = new GithubCliAdapter();

        await expect(
            ghAdapter.normalize(["pr", "view", "42"], {
                PATH: bin,
                AGENTIAM_ORIGINAL_PATH: bin,
            }),
        ).resolves.toMatchObject({
            constraints: { repository: "owner/repo" },
        });
    });
});
