import { capability, type CanonicalCapability } from "../capability.js";
import { captureOutput, resolveExecutable } from "../runtime/process.js";
import type { CliAdapter } from "./interfaces.js";

const valueOptions = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
]);

async function gitOutput(
    args: string[],
    env: NodeJS.ProcessEnv,
): Promise<string> {
    const executable = await resolveExecutable(
        "git",
        env.AGENTIAM_ORIGINAL_PATH ?? env.PATH ?? "",
    );
    return captureOutput(executable, args, env);
}

async function stagedPaths(env: NodeJS.ProcessEnv): Promise<string[]> {
    try {
        return (await gitOutput(["diff", "--cached", "--name-only", "-z"], env))
            .split("\0")
            .filter(Boolean);
    } catch {
        return [];
    }
}

async function currentBranch(
    env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
    try {
        return (
            (await gitOutput(["branch", "--show-current"], env)).trim() ||
            undefined
        );
    } catch {
        return undefined;
    }
}

export class GitCliAdapter implements CliAdapter {
    constructor(
        private readonly readStagedPaths = stagedPaths,
        private readonly readCurrentBranch = currentBranch,
    ) {}

    async normalize(
        args: string[],
        env: NodeJS.ProcessEnv = process.env,
    ): Promise<CanonicalCapability<"git">> {
        let index = 0;
        while (index < args.length) {
            const token = args[index];
            if (!token) break;
            if (valueOptions.has(token)) {
                if (!args[index + 1]) return capability("git", "unknown");
                index += 2;
                continue;
            }
            if (
                [...valueOptions].some((option) =>
                    token.startsWith(`${option}=`),
                )
            ) {
                index += 1;
                continue;
            }
            if (token.startsWith("-")) {
                index += 1;
                continue;
            }
            const command = capability("git", token);
            if (command.canonical === "git.commit") {
                const paths = await this.readStagedPaths(env);
                return paths.length > 0
                    ? { ...command, constraints: { paths } }
                    : command;
            }
            if (command.canonical === "git.push") {
                const branch = await this.readCurrentBranch(env);
                return branch
                    ? { ...command, constraints: { branches: [branch] } }
                    : command;
            }
            return command;
        }
        return capability("git", "unknown");
    }
}
