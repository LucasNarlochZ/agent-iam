import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runShim } from "../../src/runtime/shim.js";
import { resolveAuditPath } from "../../src/audit/audit.js";
import { registry } from "../../src/registry/builtins.js";

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
    it("reports normalization errors on stderr and audits them without executing", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        const normalize = vi
            .spyOn(registry.getCli("git").adapter, "normalize")
            .mockRejectedValueOnce(new Error("normalization failed"));
        const stderr = new PassThrough();
        try {
            expect(
                await runShim({
                    tool: "git",
                    args: ["add", "file.txt"],
                    env: { HOME: home, PATH: "" },
                    cwd: home,
                    stderr,
                }),
            ).toBe(126);
            expect(stderr.read()?.toString()).toContain(
                "[agentiam] ERROR normalization failed",
            );
            const record = JSON.parse(
                (
                    await readFile(resolveAuditPath({ HOME: home }), "utf8")
                ).trim(),
            );
            expect(record).toMatchObject({
                decision: "DENY",
                event: "error",
                reasonCode: "normalization_error",
                reason: "normalization failed",
                tool: "git",
            });
        } finally {
            normalize.mockRestore();
        }
    });
    it.each([
        {
            policy: "allow:\n  git.add: true\n",
            args: ["add", "file.txt"],
            code: "allow_rule",
            decision: "ALLOW",
        },
        {
            policy: "deny:\n  git.add: true\n",
            args: ["add", "file.txt"],
            code: "deny_rule",
            decision: "DENY",
        },
        {
            policy: "allow: {}\n",
            args: ["add", "file.txt"],
            code: "no_allow_rule",
            decision: "DENY",
        },
        {
            policy: "allow: {}\n",
            args: ["not-a-command"],
            code: "unsupported_capability",
            decision: "DENY",
        },
        {
            policy: "allow: invalid\n",
            args: ["add", "file.txt"],
            code: "policy_error",
            decision: "DENY",
        },
    ])(
        "audits $code with an explanation",
        async ({ policy, args, code, decision }) => {
            const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
            const bin = await mkdtemp(join(tmpdir(), "agentiam-shim-bin-"));
            await fakeTool(bin, "git");
            await mkdir(join(home, ".agentiam"));
            await writeFile(join(home, ".agentiam", "policy.yaml"), policy);
            const stderr = new PassThrough();
            await runShim({
                tool: "git",
                args,
                env: {
                    HOME: home,
                    PATH: bin,
                    AGENTIAM_TEST_OUTPUT: join(home, "args.txt"),
                },
                cwd: home,
                stderr,
                promptForApproval: async () => "skip",
            });
            const [record] = (
                await readFile(resolveAuditPath({ HOME: home }), "utf8")
            )
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            expect(record).toMatchObject({
                decision,
                reasonCode: code,
                event: "authorization",
            });
            expect(record.reason.length).toBeGreaterThan(10);
            const message = stderr.read()?.toString() ?? "";
            if (decision === "ALLOW") {
                expect(message).toBe("");
            } else {
                expect(message).toContain(
                    `[agentiam] DENY ${record.capability.canonical}:`,
                );
            }
        },
    );

    it("reports executable resolution errors on stderr and audits them", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "allow:\n  git.add: true\n",
        );
        const stderr = new PassThrough();
        expect(
            await runShim({
                tool: "git",
                args: ["add", "file.txt"],
                env: { HOME: home, PATH: "" },
                cwd: home,
                stderr,
            }),
        ).toBe(127);
        expect(stderr.read()?.toString()).toMatch(/^\[agentiam\] ERROR /);
        const records = (
            await readFile(resolveAuditPath({ HOME: home }), "utf8")
        )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(records.at(-1)).toMatchObject({
            event: "error",
            reasonCode: "execution_error",
            decision: "DENY",
        });
        expect(records.at(-1).requestId).toBe(records[0].requestId);
    });

    it("audits allow-once separately before executing the command", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-shim-bin-"));
        await fakeTool(bin, "git");
        await mkdir(join(home, ".agentiam"));
        await writeFile(join(home, ".agentiam", "policy.yaml"), "allow: {}\n");
        const stderr = new PassThrough();
        const code = await runShim({
            tool: "git",
            args: ["add", "file.txt"],
            env: {
                HOME: home,
                PATH: bin,
                AGENTIAM_TEST_OUTPUT: join(home, "args.txt"),
            },
            cwd: home,
            stderr,
            promptForApproval: async () => "allow-once",
        });
        expect(code).toBe(7);
        expect(stderr.read()?.toString()).toContain(
            "Allowing git.add once; policy unchanged",
        );
        const records = (
            await readFile(resolveAuditPath({ HOME: home }), "utf8")
        )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(records).toHaveLength(2);
        expect(records[0].requestId).toEqual(expect.any(String));
        expect(records[1].requestId).toBe(records[0].requestId);
        expect(records[0]).toMatchObject({
            decision: "DENY",
            reasonCode: "no_allow_rule",
        });
        expect(records[1]).toMatchObject({
            decision: "ALLOW",
            event: "approval",
            approval: "allow-once",
            reasonCode: "allow_once",
        });
        expect(records[1].reason).toContain("policy unchanged");
    });

    it("records why an approval broker was unavailable", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-shim-home-"));
        await mkdir(join(home, ".agentiam"));
        await writeFile(join(home, ".agentiam", "policy.yaml"), "allow: {}\n");
        const code = await runShim({
            tool: "git",
            args: ["add", "file.txt"],
            cwd: home,
            env: {
                HOME: home,
                PATH: "",
                AGENTIAM_APPROVAL_SOCKET: join(home, "missing.sock"),
            },
        });
        expect(code).toBe(126);
        const records = (
            await readFile(resolveAuditPath({ HOME: home }), "utf8")
        )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(records.at(-1)).toMatchObject({
            reasonCode: "approval_skip",
            decision: "DENY",
        });
        expect(records.at(-1).reason).toContain("broker unavailable");
    });

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
        const records = (
            await readFile(resolveAuditPath({ HOME: home }), "utf8")
        )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(records.at(-1)).toMatchObject({
            decision: "DENY",
            event: "approval",
            approval: "allow-context",
            reasonCode: "approval_allow_context",
        });
        expect(records.at(-1).reason).toContain("retry");
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
