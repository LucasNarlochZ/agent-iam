import {
    formatAuditRecord,
    readAuditRecords,
    resolveAuditPath,
} from "./audit.js";
import { loadPolicy, resolvePolicyPath } from "./policy/schema.js";

export const inspectUsage =
    "Usage: agentiam inspect policy\n       agentiam inspect logs [--head [N] | --tail [N]] [--json]";

export async function inspect(
    args: string[],
    env: NodeJS.ProcessEnv,
    output: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
    if (args[0] === "policy" && args.length === 1) {
        try {
            const { policy } = await loadPolicy(env);
            const rules = (kind: "allow" | "deny") =>
                Object.entries(policy[kind])
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(
                        ([name, rule]) =>
                            `  ${name}${rule === true ? "" : `: ${JSON.stringify(rule)}`}`,
                    )
                    .join("\n");
            output.stdout.write(
                `Policy: ${resolvePolicyPath(env)}\nDefault: DENY\n\nALLOW\n${rules("allow")}\n\nDENY\n${rules("deny")}\n`,
            );
            return 0;
        } catch (error) {
            output.stderr.write(
                `[agentiam] ERROR ${error instanceof Error ? error.message : String(error)}\n`,
            );
            return 1;
        }
    }
    if (args[0] !== "logs") {
        output.stderr.write(`${inspectUsage}\n`);
        return 1;
    }
    let mode: "head" | "tail" = "tail";
    let count = 20;
    let json = false;
    let selected = false;
    for (let index = 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--json" && !json) {
            json = true;
        } else if ((arg === "--head" || arg === "--tail") && !selected) {
            mode = arg === "--head" ? "head" : "tail";
            selected = true;
            const next = args[index + 1];
            if (next !== undefined && !next.startsWith("--")) {
                if (
                    !/^[1-9]\d*$/.test(next) ||
                    !Number.isSafeInteger(Number(next))
                ) {
                    output.stderr.write(
                        `Count must be a positive integer.\n${inspectUsage}\n`,
                    );
                    return 1;
                }
                count = Number(next);
                index += 1;
            }
        } else {
            output.stderr.write(`${inspectUsage}\n`);
            return 1;
        }
    }
    try {
        const records = await readAuditRecords(env, {
            mode,
            count,
            onInvalid: (line) =>
                output.stderr.write(
                    `[agentiam] Skipped invalid audit record at line ${line}\n`,
                ),
        });
        for (const record of records) {
            output.stdout.write(
                json
                    ? `${JSON.stringify(record)}\n`
                    : formatAuditRecord(record),
            );
        }
        return 0;
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            output.stderr.write(
                `No audit logs found at ${resolveAuditPath(env)}\n`,
            );
            return 0;
        }
        output.stderr.write(
            `[agentiam] ERROR ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
    }
}
