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
import { resolveExecutable } from "../../src/process.js";
import { startScriptedResponses } from "../support/scripted-responses.js";

const exec = promisify(execFile);
const codex = await resolveExecutable("codex", process.env.PATH ?? "").catch(
    () => undefined,
);

describe.skipIf(!codex || process.platform === "win32")("real Codex", () => {
    it.each(["ALLOW", "DENY"] as const)(
        "%s intercepts a shell command without a real model",
        async (decision) => {
            const directory = await mkdtemp(join(tmpdir(), "agentiam-codex-"));
            const home = join(directory, "home");
            const workspace = join(directory, "workspace");
            const bin = join(directory, "bin");
            const temporary = join(directory, "tmp");
            const codexHome = join(home, ".codex");
            const marker = join(directory, "git-arguments.json");
            const command = "git push origin HEAD:refs/heads/agentiam-test";
            const provider = await startScriptedResponses(command, workspace);
            try {
                await Promise.all(
                    [
                        join(home, ".agentiam"),
                        codexHome,
                        workspace,
                        bin,
                        temporary,
                    ].map((path) => mkdir(path, { recursive: true })),
                );
                await writeFile(
                    join(home, ".agentiam", "policy.yaml"),
                    `${decision === "ALLOW" ? "allow" : "deny"}:\n  git.push: true\n`,
                );
                await writeFile(
                    join(bin, "git"),
                    `#!${process.execPath}\nconst { writeFileSync } = require("node:fs");\nconst args = process.argv.slice(2);\nif (args[0] === "push") writeFileSync(${JSON.stringify(marker)}, JSON.stringify(args));\nif (args[0] === "branch") console.log("agentiam-test");\n`,
                );
                await chmod(join(bin, "git"), 0o755);
                await writeFile(
                    join(codexHome, "config.toml"),
                    `model = "gpt-5.1-codex"\nmodel_provider = "agentiam-test"\n[model_providers.agentiam-test]\nname = "Agent IAM scripted test server"\nbase_url = ${JSON.stringify(provider.url)}\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n`,
                );
                const running = exec(
                    process.execPath,
                    [
                        resolve("dist/index.js"),
                        "run",
                        "--",
                        codex!,
                        "--config",
                        "features.shell_snapshot=false",
                        "--config",
                        'web_search="disabled"',
                        "exec",
                        "--skip-git-repo-check",
                        "--sandbox",
                        "danger-full-access",
                        "--json",
                        `Run exactly: ${command}`,
                    ],
                    {
                        cwd: workspace,
                        env: {
                            HOME: home,
                            CODEX_HOME: codexHome,
                            PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
                            SHELL: "/bin/bash",
                            TMPDIR: temporary,
                            LANG: "C.UTF-8",
                        },
                        timeout: 30_000,
                        maxBuffer: 2 * 1024 * 1024,
                    },
                );
                running.child.stdin?.end();
                const result = await running;
                expect(provider.errors).toEqual([]);
                expect(
                    provider.requests,
                    `${result.stdout}\n${result.stderr}`,
                ).toHaveLength(2);
                const toolOutput = provider.requests[1]!.input.find(
                    (item) =>
                        item.type === "function_call_output" &&
                        item.call_id === "agentiam-shell-call",
                );
                expect(toolOutput).toBeDefined();
                expect(JSON.stringify(toolOutput)).toContain(
                    `[agentiam] ${decision} git.push`,
                );
                expect(JSON.stringify(toolOutput)).toMatch(
                    decision === "ALLOW"
                        ? /(?:exited with code|exit_code[\\\"]*[: ]+)\s*0/
                        : /(?:exited with code|exit_code[\\\"]*[: ]+)\s*126/,
                );
                expect(result.stdout).toContain("Scripted test complete.");
                const audit = (
                    await readFile(
                        join(home, ".agentiam", "audit.jsonl"),
                        "utf8",
                    )
                )
                    .trim()
                    .split("\n")
                    .map((line) => JSON.parse(line));
                expect(audit).toContainEqual(
                    expect.objectContaining({
                        decision,
                        tool: "git",
                        arguments: [
                            "push",
                            "origin",
                            "HEAD:refs/heads/agentiam-test",
                        ],
                        capability: expect.objectContaining({
                            canonical: "git.push",
                        }),
                    }),
                );
                if (decision === "ALLOW") {
                    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual([
                        "push",
                        "origin",
                        "HEAD:refs/heads/agentiam-test",
                    ]);
                } else {
                    await expect(readFile(marker)).rejects.toMatchObject({
                        code: "ENOENT",
                    });
                }
            } finally {
                await provider.close();
                await rm(directory, { recursive: true, force: true });
            }
        },
        40_000,
    );
});
