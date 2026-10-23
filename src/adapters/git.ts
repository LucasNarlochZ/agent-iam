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

async function stagedPaths(
    env: NodeJS.ProcessEnv,
    options: string[] = [],
): Promise<string[]> {
    try {
        return (
            await gitOutput(
                [...options, "diff", "--cached", "--name-only", "-z"],
                env,
            )
        )
            .split("\0")
            .filter(Boolean);
    } catch {
        return [];
    }
}

async function currentBranch(
    env: NodeJS.ProcessEnv,
    options: string[] = [],
): Promise<string | undefined> {
    try {
        return (
            (
                await gitOutput([...options, "branch", "--show-current"], env)
            ).trim() || undefined
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
            if (
                ["git.add", "git.commit", "git.push"].includes(
                    command.canonical,
                )
            ) {
                const options = args.slice(0, index);
                const constraints: { paths?: string[]; branches?: string[] } =
                    {};
                if (command.canonical === "git.commit") {
                    const paths = await this.readStagedPaths(env, options);
                    if (paths.length > 0) constraints.paths = paths;
                }
                const branch = await this.readCurrentBranch(env, options);
                if (branch) constraints.branches = [branch];
                return Object.keys(constraints).length > 0
                    ? { ...command, constraints }
                    : command;
            }
            return command;
        }
        return capability("git", "unknown");
    }
}
