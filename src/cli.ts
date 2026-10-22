import { constants } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolvePolicyPath } from "./policy/schema.js";
import { inspect } from "./inspect.js";
import { runShim } from "./shim.js";
import { runWithShims } from "./runner.js";
import { isToolName, isMcpToolName } from "./tools.js";
import { serveMcpApprovals } from "./mcp-approval.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serveMcpProxy } from "./mcp-proxy.js";

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
    return "Usage: agentiam --version\n       agentiam init\n       agentiam inspect policy\n       agentiam inspect logs [--head [N] | --tail [N]] [--json]\n       agentiam run -- <command> [args...]\n       agentiam mcp <registered-tool> -- <command> [args...]";
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
    if (command === "--version") {
        if (args.length !== 1) {
            output.stderr.write(
                "agentiam --version does not accept arguments\n",
            );
            return 1;
        }
        const { version } = JSON.parse(
            await readFile(new URL("../package.json", import.meta.url), "utf8"),
        );
        output.stdout.write(`${version}\n`);
        return 0;
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
        return inspect(args.slice(1), env, output);
    }
    if (command === "mcp") {
        const tool = args[1];
        if (!isMcpToolName(tool) || args[2] !== "--" || !args[3]) {
            output.stderr.write(
                "agentiam mcp requires <registered-tool> -- <command> [args...]\n",
            );
            return 1;
        }
        const childEnv = Object.fromEntries(
            Object.entries(env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
            ),
        );
        await serveMcpProxy(
            tool,
            new StdioClientTransport({
                command: args[3],
                args: args.slice(4),
                env: childEnv,
                stderr: "ignore",
            }),
            {
                env: {
                    ...env,
                    HOME: env.AGENTIAM_MCP_POLICY_HOME ?? env.HOME,
                },
                cwd: env.AGENTIAM_MCP_POLICY_CWD,
            },
        );
        return 0;
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
