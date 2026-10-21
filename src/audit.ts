import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CanonicalCapability } from "./capability.js";
import type { ToolName } from "./tools.js";

export type Decision = "ALLOW" | "DENY";

export interface AuditRecord {
    timestamp: string;
    capability: CanonicalCapability;
    decision: Decision;
    tool: ToolName | "github-mcp";
    arguments: string[];
    command: string;
    policyPath: string;
    reason: string;
}

export function resolveAuditPath(env: NodeJS.ProcessEnv = process.env): string {
    return join(env.HOME ?? homedir(), ".agentiam", "audit.jsonl");
}

export function renderCommand(tool: string, args: string[]): string {
    return [tool, ...args]
        .map((value) =>
            /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)
                ? value
                : JSON.stringify(value),
        )
        .join(" ");
}

export async function appendAuditRecord(
    record: AuditRecord,
    env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    const path = resolveAuditPath(env);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
}
