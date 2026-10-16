import { execFile } from "node:child_process";
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveExecutable } from "../../src/process.js";

const exec = promisify(execFile);
const opencode = await resolveExecutable(
    "opencode",
    process.env.PATH ?? "",
).catch(() => undefined);

describe.skipIf(!opencode || process.platform === "win32")(
    "real OpenCode",
    () => {
        it.each(["once", "reject"])(
            "handles %s through a session-scoped native permission prompt",
            async (decision) => {
                const directory = await mkdtemp(
                    join(tmpdir(), "agentiam-oc-test-"),
                );
                try {
                    const bin = join(directory, "bin");
                    await mkdir(bin);
                    await mkdir(join(directory, ".agentiam"));
                    const agentiam = join(bin, "agentiam");
                    await symlink(resolve("dist/index.js"), agentiam);
                    await writeFile(
                        join(directory, ".agentiam/policy.yaml"),
                        "allow: {}\ndeny: {}\n",
                    );
                    const driver = join(bin, "opencode");
                    await copyFile(
                        resolve("tests/support/opencode-driver.mjs"),
                        join(bin, "driver.mjs"),
                    );
                    await writeFile(
                        driver,
                        `#!/bin/sh\nif [ "$1" = "--version" ]; then exec "$AGENTIAM_TEST_OPENCODE" --version; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(bin, "driver.mjs"))}\n`,
                    );
                    await chmod(driver, 0o755);
                    const marker = join(directory, "git-push.txt");
                    await writeFile(
                        join(bin, "git"),
                        `#!${process.execPath}\nif (process.argv[2] === "push") require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
                    );
                    await chmod(join(bin, "git"), 0o755);
                    const result = await exec(
                        process.execPath,
                        [agentiam, "run", "--", driver],
                        {
                            cwd: directory,
                            env: {
                                HOME: directory,
                                XDG_CONFIG_HOME: join(directory, "config"),
                                XDG_DATA_HOME: join(directory, "data"),
                                XDG_CACHE_HOME: join(directory, "cache"),
                                XDG_STATE_HOME: join(directory, "state"),
                                PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
                                SHELL: "/bin/bash",
                                OPENCODE_SERVER_PASSWORD: "agentiam-local-test",
                                OPENCODE_DISABLE_MODELS_FETCH: "true",
                                AGENTIAM_TEST_OPENCODE: opencode!,
                                AGENTIAM_TEST_DECISION: decision,
                            },
                            timeout: 25000,
                        },
                    );
                    expect(result.stdout).toContain(
                        `Native OpenCode approval handled: ${decision}`,
                    );
                    expect(
                        await readFile(
                            join(directory, ".agentiam/audit.jsonl"),
                            "utf8",
                        ),
                    ).toContain('"canonical":"git.push"');
                    if (decision === "once") {
                        expect(await readFile(marker, "utf8")).toBe("executed");
                    } else {
                        await expect(readFile(marker)).rejects.toMatchObject({
                            code: "ENOENT",
                        });
                    }
                } finally {
                    await rm(directory, { recursive: true, force: true });
                }
            },
            30000,
        );
    },
);
