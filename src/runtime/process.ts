import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

export class ExecutableNotFoundError extends Error {}

export async function resolveExecutable(
    tool: string,
    pathValue: string,
): Promise<string> {
    for (const directory of pathValue.split(delimiter)) {
        if (!directory) continue;
        const candidate = join(directory, tool);
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            continue;
        }
    }
    throw new ExecutableNotFoundError(
        `Real executable '${tool}' was not found in the original PATH`,
    );
}

export interface ChildResult {
    code: number | null;
    signal: NodeJS.Signals | null;
}

export function captureOutput(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            env,
            stdio: ["ignore", "pipe", "ignore"],
        });
        let output = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            output += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => {
            if (code === 0) resolve(output);
            else reject(new Error(`${command} exited with code ${code}`));
        });
    });
}

export function spawnInherited(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env, stdio: "inherit" });
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
}
