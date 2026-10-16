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
        ).toEqual({ paths: ["src/policy.ts"] });
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
