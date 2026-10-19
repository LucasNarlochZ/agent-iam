import { createConnection, createServer } from "node:net";
import type { CanonicalCapability } from "./capability.js";
import { persistApproval, type ApprovalChoice } from "./approval.js";
import { isCapabilityKey, loadPolicy } from "./policy/schema.js";
import { requestFileBroker, startFileBroker } from "./file-broker.js";

const choices = new Set<ApprovalChoice>([
    "allow",
    "allow-context",
    "allow-once",
    "deny",
    "skip",
]);

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
    prompt: (capability: CanonicalCapability) => Promise<ApprovalChoice>,
    env: NodeJS.ProcessEnv,
): Promise<{ close(): Promise<void> }> {
    return startFileBroker(directory, async (input) => {
        const request = JSON.parse(input) as {
            capability?: unknown;
            expiresAt?: unknown;
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
        const choice = await prompt(capability);
        if (!choices.has(choice)) throw new Error("Invalid approval choice");
        if (Date.now() >= expiresAt) {
            throw new Error("Approval request expired");
        }
        if (choice !== "skip" && choice !== "allow-once") {
            const loaded = await loadPolicy(env);
            if (Date.now() >= expiresAt) {
                throw new Error("Approval request expired");
            }
            await persistApproval(
                loaded.path,
                loaded.policy,
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
): Promise<ApprovalChoice> {
    const choice = await requestFileBroker(
        directory,
        { capability, expiresAt: Date.now() + approvalTimeout },
        approvalTimeout,
    );
    if (typeof choice !== "string" || !choices.has(choice as ApprovalChoice)) {
        throw new Error("Invalid approval broker response");
    }
    return choice as ApprovalChoice;
}

export async function startApprovalBroker(
    path: string,
    prompt: (capability: CanonicalCapability) => Promise<ApprovalChoice>,
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
            const capability = parseCapability(input.slice(0, newline));
            if (!capability) {
                socket.end("skip\n");
                return;
            }
            const handle = async () => {
                try {
                    socket.end(`${await prompt(capability)}\n`);
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
    choice: Promise<ApprovalChoice>;
    close(): Promise<void>;
}> {
    let resolveChoice!: (choice: ApprovalChoice) => void;
    const choice = new Promise<ApprovalChoice>((resolve) => {
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
            if (choices.has(value as ApprovalChoice)) {
                resolveChoice(value as ApprovalChoice);
                socket.end("ok\n");
            } else {
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
    choice: ApprovalChoice,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ path });
        socket.setEncoding("utf8");
        let response = "";
        socket.once("connect", () => socket.end(`${choice}\n`));
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
): Promise<ApprovalChoice> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ path });
        socket.setEncoding("utf8");
        let response = "";
        socket.once("connect", () => {
            socket.write(`${JSON.stringify(capability)}\n`);
        });
        socket.on("data", (chunk: string) => {
            response += chunk;
            const newline = response.indexOf("\n");
            if (newline < 0) return;
            const choice = response.slice(0, newline) as ApprovalChoice;
            socket.destroy();
            if (choices.has(choice)) resolve(choice);
            else reject(new Error("Invalid approval broker response"));
        });
        socket.once("error", reject);
        socket.once("end", () => {
            if (!response.includes("\n")) {
                reject(new Error("Approval broker closed without a response"));
            }
        });
    });
}
