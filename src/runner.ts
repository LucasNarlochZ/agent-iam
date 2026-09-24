import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { delimiter } from "node:path";

export interface RunResult {
    code: number | null;
    signal: NodeJS.Signals | null;
}

export interface RunnerOptions {
    env?: NodeJS.ProcessEnv;
    entrypoint?: string;
    nodePath?: string;
    cwd?: string;
}

function wrapper(nodePath: string, entrypoint: string, tool: string): string {
    return `#!/bin/sh\nexec ${JSON.stringify(nodePath)} ${JSON.stringify(entrypoint)} __shim ${tool} -- "$@"\n`;
}

export async function runWithShims(
    command: string,
    args: string[],
    options: RunnerOptions = {},
): Promise<RunResult> {
    const baseEnv = { ...process.env, ...options.env };
    const originalPath = baseEnv.PATH ?? "";
    const entrypoint = resolve(
        options.entrypoint ??
            process.argv[1] ??
            join(process.cwd(), "dist/index.js"),
    );
    const nodePath = options.nodePath ?? process.execPath;
    const directory = await mkdtemp(join(tmpdir(), "agentiam-"));
    const childEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        AGENTIAM_NODE: nodePath,
        AGENTIAM_ENTRYPOINT: entrypoint,
        AGENTIAM_ORIGINAL_PATH: originalPath,
        PATH: `${directory}${delimiter}${originalPath}`,
    };
    try {
        await Promise.all(
            ["git", "gh"].map(async (tool) => {
                const path = join(directory, tool);
                await writeFile(
                    path,
                    wrapper(nodePath, entrypoint, tool),
                    "utf8",
                );
                await chmod(path, 0o755);
            }),
        );
        return await new Promise<RunResult>((resolveResult, reject) => {
            const child = spawn(command, args, {
                env: childEnv,
                cwd: options.cwd,
                stdio: "inherit",
            });
            const forward = (signal: NodeJS.Signals) => child.kill(signal);
            process.on("SIGINT", forward);
            process.on("SIGTERM", forward);
            child.once("error", reject);
            child.once("close", (code, signal) => {
                process.off("SIGINT", forward);
                process.off("SIGTERM", forward);
                resolveResult({ code, signal });
            });
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
