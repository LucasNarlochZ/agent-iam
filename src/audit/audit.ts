import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CanonicalCapability } from "../capability.js";
import {
    isToolName,
    isMcpAuditToolName,
    type ToolName,
    type McpAuditToolName,
} from "../registry/builtins.js";

export type Decision = "ALLOW" | "DENY";

export interface AuditRecord {
    timestamp: string;
    capability: CanonicalCapability;
    decision: Decision;
    tool: ToolName | McpAuditToolName;
    arguments: string[];
    command: string;
    policyPath: string;
    reason: string;
    reasonCode?: string;
    policyScope?: "global" | "directory";
    event?: "authorization" | "approval" | "error";
    approval?: string;
    requestId?: string;
}

export function parseAuditRecord(input: string): AuditRecord {
    const record = JSON.parse(input) as AuditRecord;
    if (
        !record ||
        typeof record !== "object" ||
        typeof record.timestamp !== "string" ||
        !record.capability ||
        typeof record.capability.service !== "string" ||
        typeof record.capability.action !== "string" ||
        typeof record.capability.canonical !== "string" ||
        !["ALLOW", "DENY"].includes(record.decision) ||
        (!isToolName(record.tool) && !isMcpAuditToolName(record.tool)) ||
        !Array.isArray(record.arguments) ||
        !record.arguments.every((argument) => typeof argument === "string") ||
        typeof record.command !== "string" ||
        typeof record.policyPath !== "string" ||
        typeof record.reason !== "string" ||
        (record.reasonCode !== undefined &&
            typeof record.reasonCode !== "string") ||
        (record.policyScope !== undefined &&
            !["global", "directory"].includes(record.policyScope)) ||
        (record.event !== undefined &&
            !["authorization", "approval", "error"].includes(record.event)) ||
        (record.approval !== undefined &&
            typeof record.approval !== "string") ||
        (record.requestId !== undefined && typeof record.requestId !== "string")
    ) {
        throw new Error("Invalid audit record");
    }
    return record;
}

export async function readAuditRecords(
    env: NodeJS.ProcessEnv,
    options: {
        mode: "head" | "tail";
        count: number;
        onInvalid: (line: number) => void;
    },
): Promise<AuditRecord[]> {
    const stream = createReadStream(resolveAuditPath(env), {
        encoding: "utf8",
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const records: AuditRecord[] = [];
    let lineNumber = 0;
    let total = 0;
    try {
        for await (const line of lines) {
            lineNumber += 1;
            if (!line.trim()) continue;
            let record: AuditRecord;
            try {
                record = parseAuditRecord(line);
            } catch {
                options.onInvalid(lineNumber);
                continue;
            }
            records[total % options.count] = record;
            total += 1;
            if (options.mode === "head" && total === options.count) break;
        }
    } finally {
        lines.close();
        stream.destroy();
    }
    const start = total > options.count ? total % options.count : 0;
    return [...records.slice(start), ...records.slice(0, start)];
}

export function formatAuditRecord(record: AuditRecord): string {
    const safe = (value: string) =>
        JSON.stringify(value)
            .slice(1, -1)
            .replace(
                /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
                (character) =>
                    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
            );
    return `${safe(record.timestamp)} ${record.decision} ${safe(record.capability.canonical)}${record.event === "approval" ? " [approval]" : ""}\n  Reason: ${safe(record.reason)}${record.reasonCode ? ` [${safe(record.reasonCode)}]` : ""}\n  Policy: ${safe(record.policyPath)}${record.policyScope ? ` (${record.policyScope})` : ""}\n  Command: ${safe(record.command)}\n`;
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
