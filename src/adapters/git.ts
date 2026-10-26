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

function branchCreation(command: string, args: string[]): boolean | undefined {
    if (command === "branch") {
        let literal = false;
        let hasName = false;
        const options: string[] = [];
        for (const arg of args) {
            if (!literal && arg === "--") {
                literal = true;
            } else if (!literal && arg.startsWith("-")) {
                if (
                    ![
                        "-f",
                        "--force",
                        "-t",
                        "--track",
                        "--no-track",
                        "-q",
                        "--quiet",
                        "--create-reflog",
                        "--recurse-submodules",
                    ].includes(arg) &&
                    !arg.startsWith("--track=")
                )
                    return undefined;
                options.push(arg);
            } else {
                hasName = true;
            }
        }
        return hasName ? forceRequested(options) : undefined;
    }
    if (command !== "switch" && command !== "checkout") return undefined;
    let create = false;
    let forceCreate = false;
    const options: string[] = [];
    const short = command === "switch" ? "cC" : "bB";
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (arg === "--") break;
        if (["--conflict", "--orphan", "--pathspec-from-file"].includes(arg)) {
            index++;
            continue;
        }
        const shortCreate = new RegExp(`^-[${short}]`).test(arg);
        const longCreate =
            command === "switch" && /^(--create|--force-create)(=|$)/.test(arg);
        if (shortCreate || longCreate) {
            const attached = shortCreate ? arg.length > 2 : arg.includes("=");
            const name = attached
                ? arg.slice(shortCreate ? 2 : arg.indexOf("=") + 1)
                : args[++index];
            if (!name || name.startsWith("-")) return undefined;
            create = true;
            forceCreate ||=
                /^-[CB]/.test(arg) || arg.startsWith("--force-create");
        } else if (arg.startsWith("-")) {
            options.push(arg);
        }
    }
    return create ? forceCreate || forceRequested(options) : undefined;
}

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

function worktreeRestoration(
    command: string,
    args: string[],
): boolean | undefined {
    if (command !== "restore" && command !== "checkout") return undefined;
    const before: string[] = [];
    const paths: string[] = [];
    const flags: string[] = [];
    let literal = false;
    let pathspecFile = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (!literal && arg === "--") {
            literal = true;
        } else if (!literal && arg.startsWith("-")) {
            const source =
                command === "restore" && /^(--source(=|$)|-s)/.test(arg);
            const valueOption =
                source || /^(--conflict|--pathspec-from-file)(=|$)/.test(arg);
            if (valueOption) {
                const value = arg.includes("=")
                    ? arg.slice(arg.indexOf("=") + 1)
                    : source && arg.startsWith("-s") && arg.length > 2
                      ? arg.slice(2)
                      : args[++index];
                if (!value || (value.startsWith("-") && value !== "-"))
                    return undefined;
                if (arg.startsWith("--pathspec-from-file")) pathspecFile = true;
            } else if (
                [
                    "-q",
                    "--quiet",
                    "--progress",
                    "--no-progress",
                    "-p",
                    "--patch",
                    "--ours",
                    "--theirs",
                    "-m",
                    "--merge",
                    "--ignore-unmerged",
                    "--ignore-skip-worktree-bits",
                    "--recurse-submodules",
                    "--no-recurse-submodules",
                    "--overlay",
                    "--no-overlay",
                    "--pathspec-file-nul",
                ].includes(arg) ||
                (command === "restore" && ["-W", "--worktree"].includes(arg)) ||
                (command === "checkout" && ["-f", "--force"].includes(arg))
            ) {
                flags.push(arg);
            } else {
                return undefined;
            }
        } else {
            (literal ? paths : before).push(arg);
        }
    }
    if (command === "checkout" && before.length > 0) return undefined;
    if (before.length + paths.length === 0 && !pathspecFile) return undefined;
    return forceRequested(flags);
}

function switchTarget(command: string, args: string[]): string | undefined {
    if (command !== "switch" && command !== "checkout") return undefined;
    const targets: string[] = [];
    let literal = false;
    for (const arg of args) {
        if (!literal && arg === "--") {
            if (command === "checkout" && targets.length === 0)
                return undefined;
            literal = true;
        } else if (!literal && arg !== "-" && arg.startsWith("-")) {
            if (
                ![
                    "-q",
                    "--quiet",
                    "-f",
                    "--force",
                    "--discard-changes",
                    "-m",
                    "--merge",
                    "--guess",
                    "--no-guess",
                    "--ignore-other-worktrees",
                    "--progress",
                    "--no-progress",
                    "--recurse-submodules",
                    "--no-recurse-submodules",
                    "--overwrite-ignore",
                    "--no-overwrite-ignore",
                ].includes(arg)
            )
                return undefined;
        } else {
            if (literal && command === "checkout") return undefined;
            targets.push(arg);
        }
    }
    return targets.length === 1 ? targets[0] : undefined;
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

async function isLocalBranch(
    target: string,
    env: NodeJS.ProcessEnv,
    options: string[] = [],
): Promise<boolean> {
    if (target === "HEAD" || target.startsWith("refs/")) return false;
    try {
        const ref = await gitOutput(
            [
                ...options,
                "rev-parse",
                "--symbolic-full-name",
                "--verify",
                "--end-of-options",
                target === "-" ? "@{-1}" : target,
            ],
            env,
        );
        return ref.trim().startsWith("refs/heads/");
    } catch {
        return false;
    }
}

export class GitCliAdapter implements CliAdapter {
    constructor(
        private readonly readStagedPaths = stagedPaths,
        private readonly readCurrentBranch = currentBranch,
        private readonly readIsLocalBranch = isLocalBranch,
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
            const createForce = branchCreation(token, tail);
            if (createForce !== undefined) {
                return {
                    ...capability("git", "create", "branch"),
                    constraints: { force: createForce },
                };
            }
            const restoreForce = worktreeRestoration(token, tail);
            if (restoreForce !== undefined) {
                return {
                    ...capability("git", "worktree", "restore"),
                    constraints: { force: restoreForce },
                };
            }
            const target = switchTarget(token, tail);
            if (
                target &&
                (token === "switch" ||
                    (await this.readIsLocalBranch(
                        target,
                        env,
                        args.slice(0, index),
                    )))
            ) {
                return {
                    ...capability("git", "switch", "branch"),
                    constraints: {
                        force:
                            forceRequested(tail) ||
                            tail.includes("--discard-changes"),
                    },
                };
            }
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
