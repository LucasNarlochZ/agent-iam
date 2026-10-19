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
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { resolveExecutable } from "../../src/process.js";
import { startScriptedResponses } from "../support/scripted-responses.js";
import { startTerminal } from "../support/terminal.js";

const codex = await resolveExecutable("codex", process.env.PATH ?? "").catch(
    () => undefined,
);
const exec = promisify(execFile);

describe.skipIf(!codex || process.platform !== "linux")(
    "real Codex TUI",
    () => {
        it.each([
            { choice: "allow", key: "\r", approval: "on-request" },
            { choice: "allow-once", key: "2", approval: "on-request" },
            { choice: "deny", key: "3", approval: "on-request" },
            { choice: "skip", key: "4", approval: "on-request" },
            { choice: "cancel", key: "\u001b", approval: "on-request" },
            { choice: "unavailable", key: "", approval: "never" },
        ])(
            "handles $choice through the interactive CLI",
            async ({ choice, key, approval }) => {
                const directory = await mkdtemp(
                    join(tmpdir(), "agentiam-codex-tui-"),
                );
                const home = join(directory, "home");
                const workspace = join(directory, "workspace");
                const bin = join(directory, "bin");
                const codexHome = join(home, ".codex");
                const marker = join(directory, "executed");
                const command = "aws sts get-caller-identity";
                const provider = await startScriptedResponses(
                    command,
                    workspace,
                );
                let terminal: ReturnType<typeof startTerminal> | undefined;
                try {
                    await Promise.all(
                        [
                            join(home, ".agentiam"),
                            codexHome,
                            workspace,
                            bin,
                        ].map((path) => mkdir(path, { recursive: true })),
                    );
                    const policy = join(home, ".agentiam", "policy.yaml");
                    const initialPolicy = "allow: {}\ndeny: {}\n";
                    await writeFile(policy, initialPolicy);
                    await writeFile(
                        join(bin, "aws"),
                        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
                    );
                    await chmod(join(bin, "aws"), 0o755);
                    await writeFile(
                        join(codexHome, "config.toml"),
                        `model = "gpt-5.1-codex"\nmodel_provider = "agentiam-test"\ncheck_for_update_on_startup = false\n[model_providers.agentiam-test]\nname = "Agent IAM scripted test server"\nbase_url = ${JSON.stringify(provider.url)}\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[notice]\nhide_full_access_warning = true\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,
                    );
                    const env = {
                        HOME: home,
                        CODEX_HOME: codexHome,
                        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
                        SHELL: "/bin/bash",
                        LANG: "C.UTF-8",
                    };
                    terminal = startTerminal(
                        [
                            process.execPath,
                            resolve("dist/index.js"),
                            "run",
                            "--",
                            codex!,
                            "--no-alt-screen",
                            "--ask-for-approval",
                            approval,
                            "--sandbox",
                            "danger-full-access",
                            "--config",
                            "features.shell_snapshot=false",
                            "--config",
                            'web_search="disabled"',
                            `Run exactly: ${command}`,
                        ],
                        {
                            cwd: workspace,
                            env,
                        },
                    );
                    if (choice !== "unavailable") {
                        await terminal.waitFor("Agent IAM policy decision");
                        await terminal.waitFor("4. Skip");
                        expect(await readFile(policy, "utf8")).toBe(
                            initialPolicy,
                        );
                        await expect(readFile(marker)).rejects.toMatchObject({
                            code: "ENOENT",
                        });
                        terminal.write(key);
                    }
                    await terminal.waitFor("Scripted test complete.");
                    if (choice === "unavailable") {
                        expect(terminal.output()).not.toContain(
                            "Agent IAM policy decision",
                        );
                        expect(
                            JSON.stringify(provider.requests[1]!.input),
                        ).toContain("Approval was skipped or unavailable");
                    }
                    expect(provider.errors).toEqual([]);
                    expect(provider.requests).toHaveLength(2);
                    const result = JSON.stringify(provider.requests[1]!.input);
                    expect(result).toContain(
                        "[agentiam] DENY aws.sts.get-caller-identity",
                    );
                    expect(result).toMatch(
                        choice === "allow-once"
                            ? /(?:exited with code|exit_code[\\\"]*[: ]+)\s*0/
                            : /(?:exited with code|exit_code[\\\"]*[: ]+)\s*126/,
                    );
                    const savedPolicy = await readFile(policy, "utf8");
                    if (choice === "allow" || choice === "deny") {
                        expect(parse(savedPolicy)).toEqual({
                            allow:
                                choice === "allow"
                                    ? { "aws.sts.get-caller-identity": true }
                                    : {},
                            deny:
                                choice === "deny"
                                    ? { "aws.sts.get-caller-identity": true }
                                    : {},
                        });
                    } else {
                        expect(savedPolicy).toBe(initialPolicy);
                    }
                    if (choice === "allow-once") {
                        expect(await readFile(marker, "utf8")).toBe("executed");
                    } else {
                        await expect(readFile(marker)).rejects.toMatchObject({
                            code: "ENOENT",
                        });
                    }
                    const retry = exec(
                        process.execPath,
                        [
                            resolve("dist/index.js"),
                            "run",
                            "--",
                            "sh",
                            "-c",
                            command,
                        ],
                        { cwd: workspace, env, timeout: 10_000 },
                    );
                    if (choice === "allow") {
                        await expect(retry).resolves.toMatchObject({
                            stderr: expect.stringContaining("[agentiam] ALLOW"),
                        });
                        expect(await readFile(marker, "utf8")).toBe("executed");
                    } else {
                        await expect(retry).rejects.toMatchObject({
                            code: 126,
                        });
                    }
                    const audit = (
                        await readFile(
                            join(home, ".agentiam", "audit.jsonl"),
                            "utf8",
                        )
                    )
                        .trim()
                        .split("\n")
                        .map((line) => JSON.parse(line));
                    expect(audit).toHaveLength(2);
                    expect(audit.map(({ decision }) => decision)).toEqual([
                        "DENY",
                        choice === "allow" ? "ALLOW" : "DENY",
                    ]);
                    expect(
                        audit.every(
                            ({ capability }) =>
                                capability.canonical ===
                                "aws.sts.get-caller-identity",
                        ),
                    ).toBe(true);
                } finally {
                    await terminal?.close();
                    await provider.close();
                    await rm(directory, { recursive: true, force: true });
                }
            },
            60_000,
        );
    },
);
