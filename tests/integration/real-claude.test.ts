import { execFile } from "node:child_process";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveExecutable } from "../../src/runtime/process.js";
import { startScriptedMessages } from "../support/scripted-messages.js";

const exec = promisify(execFile);
const claude = await resolveExecutable("claude", process.env.PATH ?? "").catch(
    () => undefined,
);

describe.skipIf(!claude || process.platform !== "linux")(
    "real Claude Code",
    () => {
        it.each(["ALLOW", "DENY", "ASK"] as const)(
            "%s intercepts a shell command without a real model",
            async (decision) => {
                const directory = await mkdtemp(
                    join(tmpdir(), "agentiam-claude-"),
                );
                const home = join(directory, "home");
                const workspace = join(directory, "workspace");
                const bin = join(directory, "bin");
                const marker = join(directory, "executed");
                const model = await startScriptedMessages(
                    "aws sts get-caller-identity",
                );
                try {
                    await Promise.all(
                        [join(home, ".agentiam"), workspace, bin].map((path) =>
                            mkdir(path, { recursive: true }),
                        ),
                    );
                    await writeFile(
                        join(home, ".agentiam", "policy.yaml"),
                        decision === "ASK"
                            ? "allow: {}\n"
                            : `${decision === "ALLOW" ? "allow" : "deny"}:\n  aws.sts.get-caller-identity: true\n`,
                    );
                    await writeFile(
                        join(home, ".claude.json"),
                        JSON.stringify({ hasCompletedOnboarding: true }),
                    );
                    await writeFile(
                        join(bin, "aws"),
                        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
                    );
                    await chmod(join(bin, "aws"), 0o755);
                    const result = await exec(
                        process.execPath,
                        [
                            resolve("dist/index.js"),
                            "run",
                            "--",
                            claude!,
                            "--print",
                            "--verbose",
                            "--output-format",
                            "stream-json",
                            "--model",
                            "claude-sonnet-4-6",
                            "--allowedTools",
                            "Bash",
                            "--",
                            "Run the test command.",
                        ],
                        {
                            cwd: workspace,
                            env: {
                                HOME: home,
                                PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
                                ANTHROPIC_BASE_URL: model.url,
                                ANTHROPIC_API_KEY: "agentiam-local-test",
                                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                                DISABLE_AUTOUPDATER: "1",
                            },
                            timeout: 40_000,
                            maxBuffer: 4_000_000,
                        },
                    );
                    expect(model.errors).toEqual([]);
                    expect(model.requests).toHaveLength(2);
                    const audit = (
                        await readFile(
                            join(home, ".agentiam", "audit.jsonl"),
                            "utf8",
                        )
                    )
                        .trim()
                        .split("\n")
                        .map((line) => JSON.parse(line));
                    const events = result.stdout
                        .trim()
                        .split("\n")
                        .map((line) => JSON.parse(line));
                    const init = events.find(
                        (event) =>
                            event.type === "system" && event.subtype === "init",
                    );
                    expect(init.mcp_servers).toContainEqual(
                        expect.objectContaining({
                            name: "agentiam",
                            status: "connected",
                        }),
                    );
                    expect(
                        audit.filter(
                            (record) =>
                                record.event === "authorization" &&
                                record.tool === "aws",
                        ),
                    ).toEqual([
                        expect.objectContaining({
                            decision: decision === "ALLOW" ? "ALLOW" : "DENY",
                            capability: expect.objectContaining({
                                canonical: "aws.sts.get-caller-identity",
                            }),
                        }),
                    ]);
                    if (decision === "ALLOW")
                        expect(await readFile(marker, "utf8")).toBe("executed");
                    else
                        await expect(readFile(marker)).rejects.toMatchObject({
                            code: "ENOENT",
                        });
                    expect(
                        result.stderr,
                        JSON.stringify(
                            audit.map(
                                ({
                                    capability,
                                    decision: auditDecision,
                                    event,
                                }) => ({
                                    capability: capability.canonical,
                                    decision: auditDecision,
                                    event,
                                }),
                            ),
                            null,
                            2,
                        ),
                    ).not.toContain("Approval request failed");
                } finally {
                    await model.close();
                    await rm(directory, { recursive: true, force: true });
                }
            },
            60_000,
        );
    },
);
