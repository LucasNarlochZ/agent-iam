import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    appendAuditRecord,
    parseAuditRecord,
    resolveAuditPath,
} from "../../src/audit/audit.js";

describe("audit log", () => {
    it("accepts internal error events", () => {
        const record = {
            timestamp: new Date().toISOString(),
            capability: { service: "git", action: "add", canonical: "git.add" },
            decision: "DENY",
            tool: "git",
            arguments: ["add", "file.txt"],
            command: "git add file.txt",
            policyPath: "/policy.yaml",
            reason: "executable unavailable",
            reasonCode: "execution_error",
            event: "error",
        };
        expect(parseAuditRecord(JSON.stringify(record))).toEqual(record);
    });
    it("appends structured JSONL records without losing arguments", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-audit-"));
        const record = {
            timestamp: new Date().toISOString(),
            capability: {
                service: "git" as const,
                action: "commit",
                canonical: "git.commit",
            },
            decision: "ALLOW" as const,
            tool: "git" as const,
            arguments: ["commit", "-m", "message with spaces"],
            command: 'git commit -m "message with spaces"',
            policyPath: join(home, ".agentiam", "policy.yaml"),
            reason: "matched allow rule",
        };
        await appendAuditRecord(record, { HOME: home });
        const lines = (await readFile(resolveAuditPath({ HOME: home }), "utf8"))
            .trim()
            .split("\n");
        expect(JSON.parse(lines[0]!)).toEqual(record);
    });

    it("rejects when the audit directory cannot be created", async () => {
        const home = await mkdtemp(join(tmpdir(), "agentiam-audit-"));
        await writeFile(join(home, ".agentiam"), "not a directory");
        await expect(
            appendAuditRecord({} as never, { HOME: home }),
        ).rejects.toThrow();
    });
});
