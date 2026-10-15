import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { toolNames } from "./tools.js";
import {
    requestBrokerApproval,
    startApprovalBroker,
} from "./approval-broker.js";
import { requestApproval, type ApprovalChoice } from "./approval.js";
import type { CanonicalCapability } from "./capability.js";
import { createShellEnvironment } from "./shell-environment.js";
import { getHarnessAdapter } from "./harness-adapters.js";

export interface RunResult {
    code: number | null;
    signal: NodeJS.Signals | null;
}

export interface RunnerOptions {
    env?: NodeJS.ProcessEnv;
    entrypoint?: string;
    nodePath?: string;
    cwd?: string;
    approvalPrompt?: (
        capability: CanonicalCapability,
    ) => Promise<ApprovalChoice>;
}

export function commandArgsWithEnvironment(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
): string[] {
    return getHarnessAdapter(command).commandArgs(args, env);
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
    const approvalSocket = join(directory, "approval.sock");
    const nativeApprovalSocket = join(directory, "native-approval.sock");
    let child: ReturnType<typeof spawn> | undefined;
    const harness = getHarnessAdapter(command);
    const nativeApproval =
        harness.nativeApprovals && options.approvalPrompt === undefined;
    const brokerEnabled =
        nativeApproval ||
        options.approvalPrompt !== undefined ||
        Boolean(process.stdin.isTTY && process.stderr.isTTY);
    const broker = brokerEnabled
        ? await startApprovalBroker(approvalSocket, async (capability) => {
              if (nativeApproval) {
                  return requestBrokerApproval(
                      nativeApprovalSocket,
                      capability,
                  );
              }
              const running = child?.exitCode === null;
              if (running) child?.kill("SIGSTOP");
              try {
                  return await (options.approvalPrompt ?? requestApproval)(
                      capability,
                  );
              } finally {
                  if (running) child?.kill("SIGCONT");
              }
          })
        : undefined;
    const shellEnv = await createShellEnvironment(
        directory,
        directory,
        baseEnv,
    );
    const childEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        ...shellEnv,
        AGENTIAM_NODE: nodePath,
        AGENTIAM_ENTRYPOINT: entrypoint,
        AGENTIAM_ORIGINAL_PATH: originalPath,
        ...(broker ? { AGENTIAM_APPROVAL_SOCKET: approvalSocket } : {}),
        ...(nativeApproval
            ? { AGENTIAM_NATIVE_APPROVAL_SOCKET: nativeApprovalSocket }
            : {}),
        PATH: `${directory}${delimiter}${originalPath}`,
    };
    const commandArgs = harness.commandArgs(args, childEnv);
    try {
        await Promise.all(
            toolNames.map(async (tool) => {
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
            child = spawn(command, commandArgs, {
                env: childEnv,
                cwd: options.cwd,
                stdio: "inherit",
            });
            const spawned = child;
            const forward = (signal: NodeJS.Signals) => spawned.kill(signal);
            process.on("SIGINT", forward);
            process.on("SIGTERM", forward);
            spawned.once("error", reject);
            spawned.once("close", (code, signal) => {
                process.off("SIGINT", forward);
                process.off("SIGTERM", forward);
                resolveResult({ code, signal });
            });
        });
    } finally {
        await broker?.close();
        await rm(directory, { recursive: true, force: true });
    }
}
