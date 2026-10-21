import { appendAuditRecord, type AuditRecord } from "./audit.js";
import { isToolName } from "./tools.js";
import { requestFileBroker, startFileBroker } from "./file-broker.js";

function parseRecord(input: string): AuditRecord {
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
        (!isToolName(record.tool) && record.tool !== "github-mcp") ||
        !Array.isArray(record.arguments) ||
        !record.arguments.every((argument) => typeof argument === "string") ||
        typeof record.command !== "string" ||
        typeof record.policyPath !== "string" ||
        typeof record.reason !== "string"
    ) {
        throw new Error("Invalid audit broker request");
    }
    return record;
}

export function startAuditBroker(
    directory: string,
    env: NodeJS.ProcessEnv,
): Promise<{ close(): Promise<void> }> {
    return startFileBroker(directory, (input) =>
        appendAuditRecord(parseRecord(input), env),
    );
}

export async function requestAuditWrite(
    directory: string,
    record: AuditRecord,
): Promise<void> {
    await requestFileBroker(directory, record, 5000);
}
