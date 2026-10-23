import {
    appendAuditRecord,
    parseAuditRecord,
    type AuditRecord,
} from "./audit.js";
import { requestFileBroker, startFileBroker } from "../ipc/file-broker.js";

export function startAuditBroker(
    directory: string,
    env: NodeJS.ProcessEnv,
): Promise<{ close(): Promise<void> }> {
    return startFileBroker(directory, (input) =>
        appendAuditRecord(parseAuditRecord(input), env),
    );
}

export async function requestAuditWrite(
    directory: string,
    record: AuditRecord,
): Promise<void> {
    await requestFileBroker(directory, record, 5000);
}
