import { createConnection, createServer } from "node:net";
import type { CanonicalCapability } from "./capability.js";
import type { ApprovalChoice } from "./approval.js";

const choices = new Set<ApprovalChoice>([
    "allow",
    "allow-context",
    "deny",
    "skip",
]);

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
                } catch {
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
