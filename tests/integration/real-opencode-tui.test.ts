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
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { resolveExecutable } from "../../src/runtime/process.js";
import { startTerminal } from "../support/terminal.js";

const exec = promisify(execFile);
const opencode = await resolveExecutable(
    "opencode",
    process.env.PATH ?? "",
).catch(() => undefined);

describe.skipIf(!opencode || process.platform !== "linux")(
    "real OpenCode TUI",
    () => {
        it.each([
            { choice: "allow", key: "\r" },
            { choice: "allow-once", key: "\u001b[B\r" },
            { choice: "deny", key: "\u001b[B\u001b[B\r" },
            { choice: "skip", key: "\u001b[B\u001b[B\u001b[B\r" },
            { choice: "cancel", key: "\u001b" },
            { choice: "unavailable", key: "" },
        ])(
            "handles $choice through the native approval dialog",
            async ({ choice, key }) => {
                const directory = await mkdtemp(
                    join(tmpdir(), "agentiam-opencode-tui-"),
                );
                const home = join(directory, "home");
                const workspace = join(directory, "workspace");
                const bin = join(directory, "bin");
                const fixture = join(directory, "test-plugin");
                const marker = join(directory, "executed");
                const resultPath = join(directory, "result.json");
                const command = "aws sts get-caller-identity";
                let terminal: ReturnType<typeof startTerminal> | undefined;
                try {
                    await Promise.all(
                        [join(home, ".agentiam"), workspace, bin, fixture].map(
                            (path) => mkdir(path, { recursive: true }),
                        ),
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
                        join(fixture, "package.json"),
                        JSON.stringify({ type: "module", main: "index.js" }),
                    );
                    await writeFile(
                        join(fixture, "index.js"),
                        `export default {
    id: "agentiam-tui-test",
    async setup(ctx) {
        await ctx.command.transform(editor => editor.add({
            name: "agentiam-test",
            description: "Exercise Agent IAM approval without model inference",
            async execute({ sessionID }) {
                const shell = (await ctx.tool.list()).find(tool => tool.id === "shell");
                const result = await shell.execute({ command: ${JSON.stringify(command)}, description: "Test Agent IAM" }, {
                    sessionID, agent: "build", messageID: "msg_agentiamtest", id: "call_agentiamtest",
                    signal: new AbortController().signal, progress: async () => {},
                });
                await import("node:fs/promises").then(fs => fs.writeFile(${JSON.stringify(resultPath)}, JSON.stringify(result)));
            },
        }));
    },
};\n`,
                    );
                    const env = {
                        HOME: home,
                        XDG_CONFIG_HOME: join(directory, "config"),
                        XDG_DATA_HOME: join(directory, "data"),
                        XDG_CACHE_HOME: join(directory, "cache"),
                        XDG_STATE_HOME: join(directory, "state"),
                        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
                        SHELL: "/bin/bash",
                        LANG: "C.UTF-8",
                        OPENCODE_SERVER_PASSWORD: "agentiam-local-test",
                        OPENCODE_DISABLE_MODELS_FETCH: "true",
                        OPENCODE_CONFIG_CONTENT: JSON.stringify({
                            plugins: [pathToFileURL(fixture).href],
                            permissions:
                                choice === "unavailable"
                                    ? [
                                          {
                                              action: "agentiam.allow",
                                              resource: "*",
                                              effect: "deny",
                                          },
                                      ]
                                    : [],
                        }),
                    };
                    terminal = startTerminal(
                        [
                            process.execPath,
                            resolve("dist/index.js"),
                            "run",
                            "--",
                            opencode!,
                            "--prompt",
                            "/agentiam-test",
                        ],
                        { cwd: workspace, env },
                    );
                    await terminal.waitFor(
                        "Exercise Agent IAM approval without model inference",
                    );
                    terminal.write("\r");
                    await terminal.waitFor("Build");
                    terminal.write("\r");
                    if (choice !== "unavailable") {
                        await terminal.waitFor(
                            "aws.sts.get-caller-identity was denied.",
                        );
                        await terminal.waitFor(`Command: ${command}`);
                        await terminal.waitFor("Constraints:");
                        await terminal.waitFor("Allow permanently");
                        expect(await readFile(policy, "utf8")).toBe(
                            initialPolicy,
                        );
                        await expect(readFile(marker)).rejects.toMatchObject({
                            code: "ENOENT",
                        });
                        terminal.write(key);
                    }
                    await expect
                        .poll(() => readFile(resultPath, "utf8"), {
                            timeout: 10_000,
                        })
                        .toContain(
                            "[agentiam] DENY aws.sts.get-caller-identity",
                        );
                    const result = await readFile(resultPath, "utf8");
                    expect(JSON.parse(result).metadata.exit).toBe(
                        choice === "allow-once" ? 0 : 126,
                    );
                    if (choice === "unavailable") {
                        expect(terminal.output()).not.toContain(
                            "aws.sts.get-caller-identity was denied.",
                        );
                        expect(result).toContain(
                            "Approval was skipped or unavailable",
                        );
                    }
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
                            stdout: "",
                            stderr: "",
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
                    const authorizations = audit.filter(
                        (record) => record.event === "authorization",
                    );
                    expect(authorizations).toHaveLength(2);
                    expect(
                        authorizations.map(({ decision }) => decision),
                    ).toEqual(["DENY", choice === "allow" ? "ALLOW" : "DENY"]);
                    const approval = audit.find(
                        (record) => record.event === "approval",
                    );
                    const approvalChoice =
                        choice === "cancel" || choice === "unavailable"
                            ? "skip"
                            : choice;
                    expect(approval).toMatchObject({
                        requestId: authorizations[0].requestId,
                        approval: approvalChoice,
                        decision: choice === "allow-once" ? "ALLOW" : "DENY",
                        reasonCode:
                            choice === "allow-once"
                                ? "allow_once"
                                : `approval_${approvalChoice}`,
                    });
                    expect(
                        audit.every(
                            ({ capability }) =>
                                capability.canonical ===
                                "aws.sts.get-caller-identity",
                        ),
                    ).toBe(true);
                } finally {
                    await terminal?.close();
                    await rm(directory, { recursive: true, force: true });
                }
            },
            60_000,
        );
    },
);
