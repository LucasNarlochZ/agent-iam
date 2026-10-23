import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cliTools, toolNames } from "./tools.js";
import {
    requestBrokerApproval,
    startApprovalBroker,
    startFileApprovalBroker,
} from "./approval-broker.js";
import { requestApproval, type ApprovalChoice } from "./approval.js";
import type { CanonicalCapability } from "./capability.js";
import { createShellEnvironment } from "./shell-environment.js";
import { getHarnessAdapter } from "./harnesses/index.js";
import { startAuditBroker } from "./audit-broker.js";

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

const execFileAsync = promisify(execFile);

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
    const entrypoint = await realpath(
        resolve(
            options.entrypoint ??
                process.argv[1] ??
                join(process.cwd(), "dist/index.js"),
        ),
    );
    const nodePath = options.nodePath ?? process.execPath;
    const directory = await mkdtemp(join(tmpdir(), "agentiam-"));
    const approvalSocket = join(directory, "approval.sock");
    const nativeApprovalSocket = join(directory, "native-approval.sock");
    const auditDirectory = join(directory, "audit");
    const approvalDirectory = join(directory, "approvals");
    let auditBroker: Awaited<ReturnType<typeof startAuditBroker>> | undefined;
    let fileApprovalBroker:
        Awaited<ReturnType<typeof startFileApprovalBroker>> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const harness = getHarnessAdapter(command);
    let harnessVersion: string | undefined;
    if (harness === getHarnessAdapter("opencode")) {
        try {
            const result = await execFileAsync(command, ["--version"], {
                timeout: 5000,
                env: baseEnv,
            });
            harnessVersion = result.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
        } catch {
            harnessVersion = undefined;
        }
    }
    if (harnessVersion?.startsWith("1.")) {
        baseEnv.AGENTIAM_OPENCODE_V1 = "1";
    }
    const nativeApproval =
        harness.nativeApprovals &&
        baseEnv.AGENTIAM_OPENCODE_V1 !== "1" &&
        options.approvalPrompt === undefined;
    const brokerEnabled =
        nativeApproval ||
        options.approvalPrompt !== undefined ||
        Boolean(process.stdin.isTTY && process.stderr.isTTY);
    const promptForApproval = async (
        capability: CanonicalCapability,
    ): Promise<ApprovalChoice> => {
        if (nativeApproval) {
            try {
                return await requestBrokerApproval(
                    nativeApprovalSocket,
                    capability,
                );
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ECONNREFUSED") return "skip";
                throw error;
            }
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
    };
    const broker = brokerEnabled
        ? await startApprovalBroker(approvalSocket, promptForApproval)
        : undefined;
    const fileApproval =
        brokerEnabled && harness === getHarnessAdapter("codex");
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
        AGENTIAM_MCP_POLICY_CWD: resolve(options.cwd ?? process.cwd()),
        AGENTIAM_MCP_POLICY_HOME: baseEnv.HOME,
        AGENTIAM_AUDIT_DIRECTORY: auditDirectory,
        AGENTIAM_APPROVAL_DIRECTORY: fileApproval
            ? approvalDirectory
            : undefined,
        ...(broker ? { AGENTIAM_APPROVAL_SOCKET: approvalSocket } : {}),
        ...(nativeApproval
            ? { AGENTIAM_NATIVE_APPROVAL_SOCKET: nativeApprovalSocket }
            : {}),
        PATH: `${directory}${delimiter}${originalPath}`,
    };
    try {
        auditBroker = await startAuditBroker(auditDirectory, baseEnv);
        if (fileApproval) {
            fileApprovalBroker = await startFileApprovalBroker(
                approvalDirectory,
                promptForApproval,
                baseEnv,
            );
        }
        await harness.prepare?.(childEnv, directory, command, harnessVersion, {
            args,
            cwd: resolve(options.cwd ?? process.cwd()),
        });
        const commandArgs = harness.commandArgs(args, childEnv);
        await Promise.all(
            toolNames.map(async (tool) => {
                const path = join(directory, cliTools[tool].executable);
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
        try {
            await auditBroker?.close();
        } finally {
            try {
                try {
                    await fileApprovalBroker?.close();
                } finally {
                    await broker?.close();
                }
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        }
    }
}
