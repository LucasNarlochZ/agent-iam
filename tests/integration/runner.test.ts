import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runWithShims } from "../../src/runtime/runner.js";

describe("shim runner", () => {
    it("fails closed without an error before native approvals are available", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-run-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-run-bin-"));
        const claude = join(bin, "claude");
        const output = join(home, "executed");
        const policy = "allow: {}\ndeny: {}\n";
        await mkdir(join(home, ".agentiam"));
        const policyPath = join(home, ".agentiam", "policy.yaml");
        await writeFile(policyPath, policy);
        await writeFile(claude, "#!/bin/sh\ngit remote -v\n");
        await writeFile(
            join(bin, "git"),
            '#!/bin/sh\nprintf executed > "$AGENTIAM_TEST_OUTPUT"\n',
        );
        await chmod(claude, 0o755);
        await chmod(join(bin, "git"), 0o755);

        const result = await promisify(execFile)(
            process.execPath,
            [resolve("dist/index.js"), "run", "--", claude],
            {
                cwd: home,
                env: {
                    HOME: home,
                    PATH: bin,
                    AGENTIAM_TEST_OUTPUT: output,
                },
            },
        ).catch((error) => error);

        expect(result.code).toBe(126);
        expect(result.stderr).toContain("Approval was skipped or unavailable");
        expect(result.stderr).not.toContain("Approval request failed");
        expect(await readFile(policyPath, "utf8")).toBe(policy);
        await expect(readFile(output)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("configures the native Agent IAM MCP server for Codex", async () => {
        const bin = await mkdtemp(join(tmpdir(), "agentiam-run-bin-"));
        const output = join(bin, "args.txt");
        const codex = join(bin, "codex");
        await writeFile(
            codex,
            '#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "list" ]; then printf \'[]\\n\'; exit 0; fi\nprintf \'%s\\n\' "$@" > "$AGENTIAM_TEST_OUTPUT"\n',
        );
        await chmod(codex, 0o755);

        const result = await runWithShims(codex, [], {
            entrypoint: resolve("dist/index.js"),
            env: { PATH: bin, AGENTIAM_TEST_OUTPUT: output },
        });

        expect(result).toEqual({ code: 0, signal: null });
        const args = await readFile(output, "utf8");
        expect(args).toContain("mcp_servers.agentiam.command=");
        expect(args).toContain("mcp_servers.agentiam.args=");
        expect(args).toContain(
            "mcp_servers.agentiam.env.AGENTIAM_NATIVE_APPROVAL_SOCKET=",
        );
    });

    it("intercepts tools launched by a child process", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-run-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-run-bin-"));
        const agent = join(bin, "agent");
        const output = join(home, "args.txt");
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "allow:\n  git.commit: true\n",
        );
        await writeFile(
            join(bin, "git"),
            '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$AGENTIAM_TEST_OUTPUT"\n',
        );
        await chmod(join(bin, "git"), 0o755);
        await writeFile(agent, "#!/bin/sh\ngit commit -m runner-test\n");
        await chmod(agent, 0o755);
        const result = await runWithShims(agent, [], {
            entrypoint: resolve("dist/index.js"),
            env: { HOME: home, PATH: `${bin}`, AGENTIAM_TEST_OUTPUT: output },
            cwd: home,
        });
        expect(result).toEqual({ code: 0, signal: null });
        expect(await readFile(output, "utf8")).toBe(
            "commit\n-m\nrunner-test\n",
        );
    });

    it("intercepts and authorizes AWS CLI operations", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-run-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-run-bin-"));
        const agent = join(bin, "agent");
        const output = join(home, "args.txt");
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "allow:\n  aws.sts.get-caller-identity: true\n",
        );
        await writeFile(
            join(bin, "aws"),
            '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$AGENTIAM_TEST_OUTPUT"\n',
        );
        await chmod(join(bin, "aws"), 0o755);
        await writeFile(
            agent,
            "#!/bin/sh\naws --profile development sts get-caller-identity\n",
        );
        await chmod(agent, 0o755);

        const result = await runWithShims(agent, [], {
            entrypoint: resolve("dist/index.js"),
            env: { HOME: home, PATH: bin, AGENTIAM_TEST_OUTPUT: output },
            cwd: home,
        });

        expect(result).toEqual({ code: 0, signal: null });
        expect(await readFile(output, "utf8")).toBe(
            "--profile\ndevelopment\nsts\nget-caller-identity\n",
        );
        const audit = await readFile(
            join(home, ".agentiam", "audit.jsonl"),
            "utf8",
        );
        expect(audit).toContain('"tool":"aws"');
        expect(audit).toContain('"canonical":"aws.sts.get-caller-identity"');
    });

    it("brokers approvals for commands launched inside an agent", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-run-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-run-bin-"));
        const agent = join(bin, "agent");
        const output = join(home, "args.txt");
        await mkdir(join(home, ".agentiam"));
        const policyPath = join(home, ".agentiam", "policy.yaml");
        await writeFile(policyPath, "allow: {}\ndeny: {}\n");
        await writeFile(
            join(bin, "aws"),
            '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$AGENTIAM_TEST_OUTPUT"\n',
        );
        await chmod(join(bin, "aws"), 0o755);
        await writeFile(agent, "#!/bin/sh\naws sts get-caller-identity\n");
        await chmod(agent, 0o755);

        const result = await runWithShims(agent, [], {
            entrypoint: resolve("dist/index.js"),
            env: { HOME: home, PATH: bin, AGENTIAM_TEST_OUTPUT: output },
            cwd: home,
            approvalPrompt: async () => "allow",
        });

        expect(result).toEqual({ code: 126, signal: null });
        await expect(readFile(output, "utf8")).rejects.toThrow();
        expect(await readFile(policyPath, "utf8")).toContain(
            "aws.sts.get-caller-identity: true",
        );
    });

    it("allows a command once without changing policy", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-run-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-run-bin-"));
        const agent = join(bin, "agent");
        const output = join(home, "args.txt");
        await mkdir(join(home, ".agentiam"));
        const policyPath = join(home, ".agentiam", "policy.yaml");
        await writeFile(policyPath, "allow: {}\ndeny: {}\n");
        await writeFile(
            join(bin, "aws"),
            '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$AGENTIAM_TEST_OUTPUT"\n',
        );
        await chmod(join(bin, "aws"), 0o755);
        await writeFile(agent, "#!/bin/sh\naws sts get-caller-identity\n");
        await chmod(agent, 0o755);

        const result = await runWithShims(agent, [], {
            entrypoint: resolve("dist/index.js"),
            env: { HOME: home, PATH: bin, AGENTIAM_TEST_OUTPUT: output },
            cwd: home,
            approvalPrompt: async () => "allow-once",
        });

        expect(result).toEqual({ code: 0, signal: null });
        expect(await readFile(output, "utf8")).toBe(
            "sts\nget-caller-identity\n",
        );
        expect(await readFile(policyPath, "utf8")).toBe(
            "allow: {}\ndeny: {}\n",
        );
    });

    it("preserves interception when a login shell replaces PATH", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-run-home-"));
        const bin = await mkdtemp(join(tmpdir(), "agentiam-run-bin-"));
        const output = join(home, "args.txt");
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "deny:\n  aws.s3.ls: true\n",
        );
        await writeFile(join(home, ".zprofile"), `export PATH=${bin}\n`);
        await writeFile(
            join(bin, "aws"),
            '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$AGENTIAM_TEST_OUTPUT"\n',
        );
        await chmod(join(bin, "aws"), 0o755);

        const result = await runWithShims(
            "/usr/bin/zsh",
            ["-lc", "aws s3 ls"],
            {
                entrypoint: resolve("dist/index.js"),
                env: {
                    HOME: home,
                    PATH: bin,
                    AGENTIAM_TEST_OUTPUT: output,
                },
                cwd: home,
            },
        );

        expect(result).toEqual({ code: 126, signal: null });
        await expect(readFile(output, "utf8")).rejects.toThrow();
    });
});
