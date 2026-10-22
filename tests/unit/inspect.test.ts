import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { appendAuditRecord, resolveAuditPath } from "../../src/audit.js";

async function setup(count = 0) {
    const home = await mkdtemp(join(tmpdir(), "agentiam-inspect-"));
    const env = { HOME: home };
    for (let index = 0; index < count; index += 1) {
        await appendAuditRecord(
            {
                timestamp: `2026-10-22T12:00:${String(index).padStart(2, "0")}.000Z`,
                capability: {
                    service: "git",
                    action: "add",
                    canonical: "git.add",
                },
                decision: index % 2 === 0 ? "ALLOW" : "DENY",
                tool: "git",
                arguments: ["add", `file-${index}`],
                command: `git add file-${index}`,
                policyPath: join(home, ".agentiam", "policy.yaml"),
                reason: `reason-${index}`,
            },
            env,
        );
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    return {
        home,
        env,
        run: async (args: string[]) => ({
            code: await main(["inspect", ...args], {
                env,
                output: { stdout, stderr },
            }),
            stdout: stdout.read()?.toString() ?? "",
            stderr: stderr.read()?.toString() ?? "",
        }),
    };
}

describe("inspect commands", () => {
    it("inspects policy with constraints", async () => {
        const { home, run } = await setup();
        await mkdir(join(home, ".agentiam"));
        await writeFile(
            join(home, ".agentiam", "policy.yaml"),
            "allow:\n  github.pr.view:\n    repos: [owner/repo]\ndeny:\n  git.push: true\n",
        );
        const result = await run(["policy"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("Default: DENY");
        expect(result.stdout).toContain("owner/repo");
        expect(result.stdout).toContain("git.push");
    });

    it.each([[], ["unknown"], ["policy", "extra"]])(
        "shows inspect usage for %j",
        async (...args) => {
            const { run } = await setup();
            const result = await run(args);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain("agentiam inspect policy");
            expect(result.stderr).toContain("agentiam inspect logs");
        },
    );

    it("shows the latest 20 records in chronological order by default", async () => {
        const { run } = await setup(25);
        const result = await run(["logs"]);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain("reason-4");
        expect(result.stdout).toContain("reason-5");
        expect(result.stdout).toContain("reason-24");
        expect(result.stdout.indexOf("reason-5")).toBeLessThan(
            result.stdout.indexOf("reason-24"),
        );
        expect(result.stdout).toContain("git.add");
        expect(result.stdout).toContain("policy.yaml");
    });

    it.each([
        { args: ["--head", "2"], indices: [0, 1] },
        { args: ["--tail", "2"], indices: [3, 4] },
        { args: ["--head"], indices: [0, 1, 2, 3, 4] },
        { args: ["--tail"], indices: [0, 1, 2, 3, 4] },
    ])("supports $args and JSONL output", async ({ args, indices }) => {
        const { run } = await setup(5);
        const result = await run(["logs", ...args, "--json"]);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(
            result.stdout
                .trim()
                .split("\n")
                .map((line: string) => JSON.parse(line).reason),
        ).toEqual(indices.map((index) => `reason-${index}`));
    });

    it.each([
        ["--head", "--tail"],
        ["--head", "0"],
        ["--tail", "-1"],
        ["--tail", "1.5"],
        ["--head", "abc"],
        ["--head", "9007199254740992"],
        ["--unknown"],
        ["--head", "2", "--head", "3"],
        ["--json", "extra"],
    ])("rejects invalid log options %j", async (...args) => {
        const { run } = await setup();
        const result = await run(["logs", ...args]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("agentiam inspect logs");
        expect(result.stdout).toBe("");
    });

    it("handles a missing log without creating one", async () => {
        const { env, run } = await setup();
        const result = await run(["logs"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("No audit logs");
        await expect(readFile(resolveAuditPath(env))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("skips malformed records with a warning without printing their contents", async () => {
        const { env, run } = await setup(1);
        const path = resolveAuditPath(env);
        await writeFile(
            path,
            `${await readFile(path, "utf8")}not-json-secret\n{}\n`,
        );
        const result = await run(["logs", "--json"]);
        expect(result.code).toBe(0);
        expect(result.stdout.trim().split("\n")).toHaveLength(1);
        expect(result.stderr).toContain("line 2");
        expect(result.stderr).toContain("line 3");
        expect(result.stderr).not.toContain("secret");
    });

    it("escapes terminal control characters in human-readable output", async () => {
        const { env, run } = await setup(1);
        const path = resolveAuditPath(env);
        const record = JSON.parse(await readFile(path, "utf8"));
        record.reason = "denied\u001b[2J\nforged line\u009b2J";
        await writeFile(path, `${JSON.stringify(record)}\n`);
        const result = await run(["logs"]);
        expect(result.stdout).not.toContain("\u001b");
        expect(result.stdout).not.toContain("\u009b");
        expect(result.stdout).toContain("\\u001b[2J\\nforged line");
    });
});
