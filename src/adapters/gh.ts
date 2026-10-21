import { capability, type CanonicalCapability } from "../capability.js";
import { captureOutput, resolveExecutable } from "../process.js";
import type { CliAdapter } from "./interfaces.js";

const valueOptions = new Set(["--repo", "-R", "--hostname"]);

function parseRepository(value: string): string | undefined {
    const remote = value.trim();
    const ssh = remote.match(/^[^@]+@[^:]+:(.+)$/);
    const path =
        ssh?.[1] ??
        (() => {
            try {
                return new URL(remote).pathname.slice(1);
            } catch {
                return remote;
            }
        })();
    const repository = path.replace(/\.git$/, "").replace(/\/$/, "");
    return /^[^/]+\/[^/]+$/.test(repository) ? repository : undefined;
}

async function repositoryFromGit(
    env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
    try {
        const executable = await resolveExecutable(
            "git",
            env.AGENTIAM_ORIGINAL_PATH ?? env.PATH ?? "",
        );
        return parseRepository(
            await captureOutput(
                executable,
                ["remote", "get-url", "origin"],
                env,
            ),
        );
    } catch {
        return undefined;
    }
}

function explicitRepository(args: string[]): string | undefined {
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--repo" || token === "-R") return args[index + 1];
        if (token?.startsWith("--repo=")) return token.slice("--repo=".length);
    }
    return undefined;
}

function pullRequestNumber(positional: string[]): number | undefined {
    if (positional[0] !== "pr" || positional[1] !== "merge") return undefined;
    const value = positional[2];
    return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

export class GithubCliAdapter implements CliAdapter {
    async normalize(
        args: string[],
        env: NodeJS.ProcessEnv = process.env,
    ): Promise<CanonicalCapability<"github">> {
        const positional: string[] = [];
        let index = 0;
        while (index < args.length) {
            const token = args[index];
            if (!token) break;
            if (valueOptions.has(token)) {
                if (!args[index + 1]) return capability("github", "unknown");
                index += 2;
                continue;
            }
            if (token.startsWith("-")) {
                index += 1;
                continue;
            }
            positional.push(token);
            index += 1;
        }
        const command =
            positional.length >= 2
                ? capability("github", positional[1]!, positional[0])
                : capability("github", positional[0] ?? "unknown");
        const repository =
            explicitRepository(args) ?? (await repositoryFromGit(env));
        const pullRequest = pullRequestNumber(positional);
        const constraints = {
            ...(repository ? { repository } : {}),
            ...(pullRequest === undefined ? {} : { pullRequest }),
        };
        return Object.keys(constraints).length > 0
            ? { ...command, constraints }
            : command;
    }
}
