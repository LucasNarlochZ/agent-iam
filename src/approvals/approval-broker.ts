import { createConnection, createServer } from "node:net";
import type { CanonicalCapability } from "../capability.js";
import {
    isApprovalDecision,
    persistApprovalDecision,
    type ApprovalDecision,
    type ApprovalContext,
} from "./approval.js";
import { isCapabilityKey, resolvePolicyPath } from "../policy/schema.js";
import { requestFileBroker, startFileBroker } from "../ipc/file-broker.js";

function parseContext(value: unknown): ApprovalContext | undefined {
    if (!value || typeof value !== "object") return undefined;
    const context = value as Record<string, unknown>;
    return typeof context.cwd === "string" &&
        typeof context.globalPolicyPath === "string" &&
        (context.command === undefined || typeof context.command === "string")
        ? (context as unknown as ApprovalContext)
        : undefined;
}

function decodeDecision(value: string): ApprovalDecision {
    let decision: unknown = value;
    if (value.startsWith("{")) decision = JSON.parse(value);
    if (!isApprovalDecision(decision))
        throw new Error("Invalid approval broker response");
    return decision;
}

function encodeDecision(decision: ApprovalDecision): string {
    if (!isApprovalDecision(decision))
        throw new Error("Invalid approval choice");
    return typeof decision === "string" ? decision : JSON.stringify(decision);
}

const approvalTimeout = 300_000;

function parseCapability(value: string): CanonicalCapability | undefined {
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        return typeof parsed.service === "string" &&
            typeof parsed.action === "string" &&
            typeof parsed.canonical === "string" &&
            (parsed.constraints === undefined ||
                (typeof parsed.constraints === "object" &&
                    parsed.constraints !== null &&
                    !Array.isArray(parsed.constraints)))
            ? (parsed as unknown as CanonicalCapability)
            : undefined;
    } catch {
        return undefined;
    }
}

export function startFileApprovalBroker(
    directory: string,
    prompt: (
        capability: CanonicalCapability,
        context?: ApprovalContext,
    ) => Promise<ApprovalDecision>,
    env: NodeJS.ProcessEnv,
): Promise<{ close(): Promise<void> }> {
    return startFileBroker(directory, async (input) => {
        const request = JSON.parse(input) as {
            capability?: unknown;
            expiresAt?: unknown;
            context?: unknown;
        };
        const capability = parseCapability(JSON.stringify(request?.capability));
        const expiresAt = request?.expiresAt;
        if (
            !capability ||
            !isCapabilityKey(capability.canonical) ||
            typeof expiresAt !== "number" ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= Date.now()
        ) {
            throw new Error("Invalid or expired approval request");
        }
        const context = parseContext(request.context) ?? {
            cwd: process.cwd(),
            globalPolicyPath: resolvePolicyPath(env),
        };
        const choice = await prompt(capability, context);
        if (!isApprovalDecision(choice))
            throw new Error("Invalid approval choice");
        if (Date.now() >= expiresAt) {
            throw new Error("Approval request expired");
        }
        if (choice !== "skip" && choice !== "allow-once") {
            if (Date.now() >= expiresAt) {
                throw new Error("Approval request expired");
            }
            await persistApprovalDecision(
                { ...context, globalPolicyPath: resolvePolicyPath(env) },
                capability,
                choice,
            );
        }
        return choice;
    });
}

export async function requestFileApproval(
    directory: string,
    capability: CanonicalCapability,
    context?: ApprovalContext,
): Promise<ApprovalDecision> {
    const choice = await requestFileBroker(
        directory,
        { capability, context, expiresAt: Date.now() + approvalTimeout },
        approvalTimeout,
    );
    if (!isApprovalDecision(choice)) {
        throw new Error("Invalid approval broker response");
    }
    return choice;
}

export async function startApprovalBroker(
    path: string,
    prompt: (
        capability: CanonicalCapability,
        context?: ApprovalContext,
    ) => Promise<ApprovalDecision>,
): Promise<{ close(): Promise<void> }> {
    let pending = Promise.resolve();
    const server = createServer((socket) => {
        socket.setEncoding("utf8");
        let input = "";
        let handled = false;
        socket.on("data", (chunk: string) => {
            if (handled) return;
            input += chunk;
            if (input.length > 65_536) {
                handled = true;
                socket.end("skip\n");
                return;
            }
            const newline = input.indexOf("\n");
            if (newline < 0) return;
            handled = true;
            let payload: { capability?: unknown; context?: unknown };
            try {
                payload = JSON.parse(input.slice(0, newline));
            } catch {
                socket.end("skip\n");
                return;
            }
            if (!payload || typeof payload !== "object") {
                socket.end("skip\n");
                return;
            }
            const capability = parseCapability(
                JSON.stringify(payload.capability ?? payload),
            );
            const context = parseContext(payload.context);
            if (!capability) {
                socket.end("skip\n");
                return;
            }
            const handle = async () => {
                try {
                    socket.end(
                        `${encodeDecision(await prompt(capability, context))}\n`,
                    );
                } catch (error) {
                    process.stderr.write(
                        `[agentiam] Approval request failed: ${error instanceof Error ? error.message : String(error)}\n`,
                    );
                    socket.end("skip\n");
                }
            };
            pending = pending.then(handle, handle);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        async close() {
            await pending;
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
}

export async function startApprovalChoiceChannel(path: string): Promise<{
    choice: Promise<ApprovalDecision>;
    close(): Promise<void>;
}> {
    let resolveChoice!: (choice: ApprovalDecision) => void;
    const choice = new Promise<ApprovalDecision>((resolve) => {
        resolveChoice = resolve;
    });
    const server = createServer((socket) => {
        socket.setEncoding("utf8");
        let input = "";
        socket.on("data", (chunk: string) => {
            input += chunk;
            const newline = input.indexOf("\n");
            if (newline < 0) return;
            const value = input.slice(0, newline);
            try {
                resolveChoice(decodeDecision(value));
                socket.end("ok\n");
            } catch {
                socket.end("skip\n");
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        choice,
        async close() {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
}

export function sendApprovalChoice(
    path: string,
    choice: ApprovalDecision,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ path });
        socket.setEncoding("utf8");
        let response = "";
        socket.once("connect", () => socket.end(`${encodeDecision(choice)}\n`));
        socket.on("data", (chunk: string) => {
            response += chunk;
            const newline = response.indexOf("\n");
            if (newline < 0) return;
            if (response.slice(0, newline) === "ok") resolve();
            else reject(new Error("Approval choice delivery failed"));
        });
        socket.once("error", reject);
        socket.once("end", () => {
            if (!response.includes("\n")) {
                reject(new Error("Approval choice channel closed"));
            }
        });
    });
}

export function requestBrokerApproval(
    path: string,
    capability: CanonicalCapability,
    context?: ApprovalContext,
): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ path });
        socket.setEncoding("utf8");
        let response = "";
        socket.once("connect", () => {
            socket.write(
                `${JSON.stringify(context ? { capability, context } : capability)}\n`,
            );
        });
        socket.on("data", (chunk: string) => {
            response += chunk;
            const newline = response.indexOf("\n");
            if (newline < 0) return;
            socket.destroy();
            try {
                resolve(decodeDecision(response.slice(0, newline)));
            } catch (error) {
                reject(error);
            }
        });
        socket.once("error", reject);
        socket.once("end", () => {
            if (!response.includes("\n")) {
                reject(new Error("Approval broker closed without a response"));
            }
        });
    });
}
