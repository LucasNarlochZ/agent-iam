import {
    capability,
    type CanonicalCapability,
    type ConstraintValue,
} from "../capability.js";
import { captureOutput, resolveExecutable } from "../runtime/process.js";
import type { CliAdapter } from "./interfaces.js";

const valueOptions = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
]);

function forceRequested(args: string[]): boolean {
    let force = false;
    let lease = false;
    const valueFlags = new Set([
        "-m",
        "--message",
        "-F",
        "--file",
        "--repo",
        "--receive-pack",
        "--exec",
        "--push-option",
        "-o",
    ]);
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--") break;
        if (valueFlags.has(arg)) {
            i++;
            continue;
        }
        if (arg === "--no-force") force = false;
        if (arg === "--no-force-with-lease") lease = false;
        if (arg === "--force" || /^-[^-]*f/.test(arg)) force = true;
        if (
            arg === "--force-with-lease" ||
            arg.startsWith("--force-with-lease=")
        )
            lease = true;
    }
    return force || lease;
}

function pushContext(args: string[]): {
    refspecs: string[];
    multiple: boolean;
    mirror: boolean;
} {
    const positionals: string[] = [];
    let repositoryOption = false;
    let multiple = false;
    let mirror = false;
    let literal = false;
    const optionsWithValues = new Set([
        "--repo",
        "--receive-pack",
        "--exec",
        "--push-option",
        "-o",
    ]);
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (!literal && arg === "--") {
            literal = true;
            continue;
        }
        if (!literal && optionsWithValues.has(arg)) {
            if (arg === "--repo") repositoryOption = true;
            i++;
            continue;
        }
        if (!literal && arg.startsWith("--repo=")) repositoryOption = true;
        if (
            !literal &&
            [
                "--all",
                "--branches",
                "--mirror",
                "--tags",
                "--follow-tags",
            ].includes(arg)
        )
            multiple = true;
        if (!literal && arg === "--mirror") mirror = true;
        if (!literal && arg.startsWith("-")) continue;
        positionals.push(arg);
    }
    return {
        refspecs: positionals.slice(repositoryOption ? 0 : 1),
        multiple,
        mirror,
    };
}

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
            const tail = args.slice(index + 1);
            if (token === "worktree" || token === "remote") {
                const subcommand = tail.find((arg) => !arg.startsWith("-"));
                const action =
                    subcommand === "rm" && token === "remote"
                        ? "remove"
                        : subcommand;
                const command = action
                    ? capability("git", action, token)
                    : capability("git", token);
                return {
                    ...command,
                    constraints: { force: forceRequested(tail) },
                };
            }
            const command = capability("git", token);
            if (token === "push") {
                const { refspecs, multiple, mirror } = pushContext(tail);
                const constraints: Record<string, ConstraintValue> = {
                    force:
                        forceRequested(tail) ||
                        mirror ||
                        refspecs.some((ref) => ref.startsWith("+")),
                };
                if (!multiple && refspecs.length > 0) {
                    const branches: string[] = [];
                    for (const ref of refspecs) {
                        let destination = ref
                            .replace(/^\+/, "")
                            .split(":")
                            .at(-1)!;
                        if (destination === "HEAD")
                            destination =
                                (await this.readCurrentBranch(
                                    env,
                                    args.slice(0, index),
                                )) ?? "";
                        if (
                            !destination ||
                            destination.includes("*") ||
                            (destination.startsWith("refs/") &&
                                !destination.startsWith("refs/heads/"))
                        ) {
                            return { ...command, constraints };
                        }
                        branches.push(
                            destination.replace(/^refs\/heads\//, ""),
                        );
                    }
                    constraints.branches = [...new Set(branches)];
                } else if (!multiple) {
                    const branch = await this.readCurrentBranch(
                        env,
                        args.slice(0, index),
                    );
                    if (branch) constraints.branches = [branch];
                }
                return { ...command, constraints };
            }
            if (["git.add", "git.commit"].includes(command.canonical)) {
                const options = args.slice(0, index);
                const constraints: Record<string, ConstraintValue> = {
                    force: forceRequested(tail),
                };
                if (command.canonical === "git.commit") {
                    const paths = await this.readStagedPaths(env, options);
                    if (paths.length > 0) constraints.paths = paths;
                }
                const branch = await this.readCurrentBranch(env, options);
                if (branch) constraints.branches = [branch];
                return { ...command, constraints };
            }
            return { ...command, constraints: { force: forceRequested(tail) } };
        }
        return capability("git", "unknown");
    }
}
