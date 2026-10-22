import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runShim } from "../../src/shim.js";

async function fakeTool(directory: string, tool: string): Promise<string> {
    const path = join(directory, tool);
    await writeFile(
        path,
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$AGENTIAM_TEST_OUTPUT"\nexit 7\n',
    );
    await chmod(path, 0o755);
    return path;
}

describe("command shim", () => {
    it.each([
        {
            tool: "git" as const,
            args: ["add", "file.txt"],
            canonical: "git.add",
        },
        {
            tool: "gh" as const,
            args: ["pr", "review", "42", "--repo", "owner/repo"],
            canonical: "github.pr.review",
        },
    ])(
        "prompts and persists approval for $canonical without executing it",
        async ({ tool, args, canonical }) => {
            const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
            await mkdir(join(home, ".agentiam"));
            const policyPath = join(home, ".agentiam", "policy.yaml");
            await writeFile(policyPath, "allow: {}\ndeny: {}\n");
            let requested = "";

            const code = await runShim({
                tool,
                args,
                env: { HOME: home, PATH: "" },
                cwd: home,
                promptForApproval: async (capability) => {
                    requested = capability.canonical;
                    return "allow";
                },
            });

            expect(requested).toBe(canonical);
            expect(code).toBe(126);
            expect(await readFile(policyPath, "utf8")).toContain(
                `${canonical}: true`,
            );
        },
    );

    it("applies a parent directory policy as an additional restriction", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-shim-bin-"));
        const project = await mkdtemp(join(tmpdir(), "agentiam-project-"));
        const nested = join(project, "packages", "app");
        const output = join(home, "args.txt");
        await fakeTool(bin, "git");
        await mkdir(join(home, ".agentiam"));
        await mkdir(join(project, ".agentiam"));
        await mkdir(nested, { recursive: true });
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "allow:\n  git.commit: true\n",
        );
        await writeFile(
            join(project, ".agentiam", "policy.yaml"),
            "deny:\n  git.commit: true\n",
        );

        const code = await runShim({
            tool: "git",
            args: ["commit", "-m", "message"],
            env: {
                HOME: home,
                PATH: bin,
                AGENTIAM_ORIGINAL_PATH: bin,
                AGENTIAM_TEST_OUTPUT: output,
            },
            cwd: nested,
        });

        expect(code).toBe(126);
        expect(await readFile(output, "utf8")).toBe(
            "diff\n--cached\n--name-only\n-z\n",
        );
    });

    it("does not let a directory policy override a global deny", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-shim-bin-"));
        const project = await mkdtemp(join(tmpdir(), "agentiam-project-"));
        const output = join(home, "args.txt");
        await fakeTool(bin, "gh");
        await mkdir(join(home, ".agentiam"));
        await mkdir(join(project, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "deny:\n  github.pr.merge: true\n",
        );
        await writeFile(
            join(project, ".agentiam", "policy.yaml"),
            "allow:\n  github.pr.merge: true\n",
        );

        const code = await runShim({
            tool: "gh",
            args: ["pr", "merge", "42"],
            env: {
                HOME: home,
                PATH: bin,
                AGENTIAM_ORIGINAL_PATH: bin,
                AGENTIAM_TEST_OUTPUT: output,
            },
            cwd: project,
        });

        expect(code).toBe(126);
        await expect(readFile(output, "utf8")).rejects.toThrow();
    });

    it("allows and executes the real binary with unchanged arguments", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-shim-bin-"));
        const cwd = await mkdtemp(join(tmpdir(), "agentiam-shim-cwd-"));
        const output = join(home, "args.txt");
        await fakeTool(bin, "git");
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "allow:\n  git.commit: true\n",
        );
        const code = await runShim({
            tool: "git",
            args: ["commit", "-m", "message with spaces"],
            env: {
                HOME: home,
                PATH: bin,
                AGENTIAM_ORIGINAL_PATH: bin,
                AGENTIAM_TEST_OUTPUT: output,
            },
            cwd,
        });
        expect(code).toBe(7);
        expect(await readFile(output, "utf8")).toBe(
            "commit\n-m\nmessage with spaces\n",
        );
    });

    it("denies without executing the real binary", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-shim-bin-"));
        const cwd = await mkdtemp(join(tmpdir(), "agentiam-shim-cwd-"));
        const output = join(home, "args.txt");
        await fakeTool(bin, "gh");
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "deny:\n  github.pr.merge: true\n",
        );
        const code = await runShim({
            tool: "gh",
            args: ["pr", "merge", "42"],
            env: {
                HOME: home,
                PATH: bin,
                AGENTIAM_ORIGINAL_PATH: bin,
                AGENTIAM_TEST_OUTPUT: output,
            },
            cwd,
            promptForApproval: async () => {
                throw new Error("explicit denies must not prompt");
            },
        });
        expect(code).toBe(126);
        await expect(readFile(output, "utf8")).rejects.toThrow();
    });

    it("explains when a native policy approval is skipped or unavailable", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-shim-bin-"));
        const cwd = await mkdtemp(join(tmpdir(), "agentiam-shim-cwd-"));
        await fakeTool(bin, "aws");
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "allow: {}\ndeny: {}\n",
        );
        let message = "";
        const stderr = new Writable({
            write(chunk, _encoding, callback) {
                message += chunk.toString();
                callback();
            },
        });

        const code = await runShim({
            tool: "aws",
            args: ["s3", "ls"],
            env: {
                HOME: home,
                PATH: bin,
                AGENTIAM_ORIGINAL_PATH: bin,
                AGENTIAM_NATIVE_APPROVAL_SOCKET: join(home, "approval.sock"),
            },
            cwd,
            stderr,
            promptForApproval: async () => "skip",
        });

        expect(code).toBe(126);
        expect(message).toContain("Approval was skipped or unavailable");
        expect(message).toContain("Check broker errors");
        expect(message).toContain("the harness's native approval settings");
        expect(message).toContain("command remains denied");
    });

    it("does not prompt for capabilities that cannot be stored in policy", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-shim-bin-"));
        await fakeTool(bin, "gh");
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "allow: {}\ndeny: {}\n",
        );
        let prompted = false;

        const code = await runShim({
            tool: "gh",
            args: ["issues", "list"],
            env: {
                HOME: home,
                PATH: bin,
                AGENTIAM_ORIGINAL_PATH: bin,
            },
            promptForApproval: async () => {
                prompted = true;
                return "allow";
            },
        });

        expect(code).toBe(126);
        expect(prompted).toBe(false);
    });

    it("saves a repository-scoped allow after interactive approval without executing the denied command", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-shim-bin-"));
        const cwd = await mkdtemp(join(tmpdir(), "agentiam-shim-cwd-"));
        const output = join(home, "args.txt");
        let messages = "";
        const stderr = new Writable({
            write(chunk, _encoding, callback) {
                messages += chunk.toString();
                callback();
            },
        });
        await fakeTool(bin, "gh");
        await mkdir(join(home, ".agentiam"));
        const policyPath = join(home, ".agentiam", "policy.yaml");
        await writeFile(policyPath, "allow: {}\ndeny: {}\n");

        const code = await runShim({
            tool: "gh",
            args: ["--repo", "owner/repo", "pr", "merge", "42"],
            env: {
                HOME: home,
                PATH: bin,
                AGENTIAM_ORIGINAL_PATH: bin,
                AGENTIAM_TEST_OUTPUT: output,
            },
            cwd,
            stderr,
            promptForApproval: async () => "allow-context",
        });

        expect(code).toBe(126);
        await expect(readFile(output, "utf8")).rejects.toThrow();
        expect(await readFile(policyPath, "utf8")).toContain(
            "github.pr.merge:\n    repos:\n      - owner/repo",
        );
        expect(messages).toContain("Saved allow rule");
        expect(messages).toContain("retry the command");
    });

    it("enforces repository-scoped GitHub rules before executing gh", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-shim-bin-"));
        const cwd = await mkdtemp(join(tmpdir(), "agentiam-shim-cwd-"));
        const output = join(home, "args.txt");
        await fakeTool(bin, "gh");
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "allow:\n  github.pr.merge:\n    repos:\n      - owner/repo\n",
        );
        const env = {
            HOME: home,
            PATH: bin,
            AGENTIAM_ORIGINAL_PATH: bin,
            AGENTIAM_TEST_OUTPUT: output,
        };
        const allowed = await runShim({
            tool: "gh",
            args: ["--repo", "owner/repo", "pr", "merge", "42"],
            env,
            cwd,
        });
        expect(allowed).toBe(7);
        expect(await readFile(output, "utf8")).toBe(
            "--repo\nowner/repo\npr\nmerge\n42\n",
        );

        const denied = await runShim({
            tool: "gh",
            args: ["--repo", "other/repo", "pr", "merge", "42"],
            env,
            cwd,
        });
        expect(denied).toBe(126);
        expect(await readFile(output, "utf8")).toBe(
            "--repo\nowner/repo\npr\nmerge\n42\n",
        );
    });
});
