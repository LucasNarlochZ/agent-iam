import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadPolicy, resolvePolicyPath } from "./policy/schema.js";
import { runShim } from "./shim.js";
import { runWithShims } from "./runner.js";
import { isToolName } from "./tools.js";
import { serveMcpApprovals } from "./mcp-approval.js";

interface Output {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
}

export interface CliDependencies {
    env?: NodeJS.ProcessEnv;
    output?: Output;
    run?: typeof runWithShims;
    shim?: typeof runShim;
    resignal?: (signal: NodeJS.Signals) => void;
    mcp?: (path: string) => Promise<void>;
}

function usage(): string {
    return "Usage: agentiam init\n       agentiam inspect\n       agentiam run -- <command> [args...]";
}

export async function main(
    args: string[],
    dependencies: CliDependencies = {},
): Promise<number> {
    const env = dependencies.env ?? process.env;
    const output = dependencies.output ?? {
        stdout: process.stdout,
        stderr: process.stderr,
    };
    const run = dependencies.run ?? runWithShims;
    const shim = dependencies.shim ?? runShim;
    const resignal =
        dependencies.resignal ??
        ((signal: NodeJS.Signals) => process.kill(process.pid, signal));
    const command = args[0];
    if (!command) {
        output.stderr.write(`${usage()}\n`);
        return 1;
    }
    if (command === "init") {
        if (args.length !== 1) {
            output.stderr.write("agentiam init does not accept arguments\n");
            return 1;
        }
        const policyPath = resolvePolicyPath(env);
        try {
            await mkdir(dirname(policyPath), { recursive: true });
            await copyFile(
                new URL("../examples/policy.yaml", import.meta.url),
                policyPath,
                constants.COPYFILE_EXCL,
            );
            output.stdout.write(`Initialized policy: ${policyPath}\n`);
            return 0;
        } catch (error) {
            output.stderr.write(
                `[agentiam] ERROR ${error instanceof Error ? error.message : String(error)}\n`,
            );
            return 1;
        }
    }
    if (command === "inspect") {
        if (args.length !== 1) {
            output.stderr.write("agentiam inspect does not accept arguments\n");
            return 1;
        }
        try {
            const { policy } = await loadPolicy(env);
            const allow = Object.keys(policy.allow)
                .sort()
                .map((item) => `  ${item}`)
                .join("\n");
            const deny = Object.keys(policy.deny)
                .sort()
                .map((item) => `  ${item}`)
                .join("\n");
            output.stdout.write(
                `Policy: ${resolvePolicyPath(env)}\nDefault: DENY\n\nALLOW\n${allow}\n\nDENY\n${deny}\n`,
            );
            return 0;
        } catch (error) {
            output.stderr.write(
                `[agentiam] ERROR ${error instanceof Error ? error.message : String(error)}\n`,
            );
            return 1;
        }
    }
    if (command === "run") {
        const separator = args.indexOf("--");
        if (separator < 0 || separator === args.length - 1) {
            output.stderr.write("agentiam run requires -- <command>\n");
            return 1;
        }
        const result = await run(
            args[separator + 1]!,
            args.slice(separator + 2),
            { env },
        );
        if (result.signal) {
            resignal(result.signal);
            return 128;
        }
        return result.code ?? 1;
    }
    if (command === "__shim") {
        const tool = args[1];
        const separator = args.indexOf("--");
        if (!isToolName(tool) || separator < 0 || separator < 2) {
            output.stderr.write("Invalid internal shim invocation\n");
            return 1;
        }
        return shim({
            tool,
            args: args.slice(separator + 1),
            env,
            stderr: output.stderr,
        });
    }
    if (command === "__mcp") {
        const socketPath = env.AGENTIAM_NATIVE_APPROVAL_SOCKET;
        if (!socketPath) {
            output.stderr.write("Missing native approval socket\n");
            return 1;
        }
        await (dependencies.mcp ?? serveMcpApprovals)(socketPath);
        return 0;
    }
    output.stderr.write(`${usage()}\n`);
    return 1;
}
