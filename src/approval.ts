import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stringify } from "yaml";
import type { CanonicalCapability } from "./capability.js";
import type { CapabilityKey, Policy, PolicyRule } from "./policy/schema.js";

export type ApprovalChoice = "allow" | "allow-context" | "deny" | "skip";

export interface ApprovalPromptOptions {
    isTTY?: boolean;
    ask?: (question: string) => Promise<string>;
}

function contextLabel(capability: CanonicalCapability): string | undefined {
    if (capability.service === "github") {
        return capability.constraints?.repository
            ? `repository ${capability.constraints.repository}`
            : undefined;
    }
    if (capability.service === "aws") return undefined;
    if (capability.constraints?.paths?.length) {
        return `paths ${capability.constraints.paths.join(", ")}`;
    }
    if (capability.constraints?.branches?.length) {
        return `branch ${capability.constraints.branches.join(", ")}`;
    }
    return undefined;
}

export async function requestApproval(
    capability: CanonicalCapability,
    options: ApprovalPromptOptions = {},
): Promise<ApprovalChoice> {
    const isTTY =
        options.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
    if (!isTTY) return "skip";

    const context = contextLabel(capability);
    const choices: Array<{ label: string; value: ApprovalChoice }> = [
        { label: "Allow this capability", value: "allow" },
        ...(context
            ? [
                  {
                      label: `Allow for ${context}`,
                      value: "allow-context" as const,
                  },
              ]
            : []),
        { label: "Explicitly deny", value: "deny" },
        { label: "Skip", value: "skip" },
    ];
    const prompt = `[agentiam] ${capability.canonical} was denied.\n${choices
        .map((choice, index) => `  ${index + 1}) ${choice.label}`)
        .join("\n")}\nChoose an action: `;

    let readline: ReturnType<typeof createInterface> | undefined;
    const ask =
        options.ask ??
        (async (question: string) => {
            readline ??= createInterface({
                input: process.stdin,
                output: process.stderr,
            });
            return readline.question(question);
        });
    try {
        while (true) {
            const answer = (await ask(prompt)).trim();
            const selected = choices[Number(answer) - 1];
            if (selected) return selected.value;
        }
    } finally {
        readline?.close();
    }
}

function contextualRule(
    capability: CanonicalCapability,
): PolicyRule | undefined {
    if (capability.service === "github") {
        return capability.constraints?.repository
            ? { repos: [capability.constraints.repository] }
            : undefined;
    }
    if (capability.service === "aws") return undefined;
    if (capability.constraints?.paths?.length) {
        return { paths: capability.constraints.paths };
    }
    if (capability.constraints?.branches?.length) {
        return { branches: capability.constraints.branches };
    }
    return undefined;
}

export async function persistApproval(
    path: string,
    policy: Policy,
    capability: CanonicalCapability,
    choice: ApprovalChoice,
): Promise<void> {
    if (choice === "skip") return;
    const key = capability.canonical as CapabilityKey;
    if (choice === "deny") {
        policy.deny[key] = true;
    } else if (choice === "allow") {
        policy.allow[key] = true;
    } else {
        const rule = contextualRule(capability);
        if (!rule) return;
        const existing = policy.allow[key];
        if (existing !== true) {
            const merged: Record<string, string[]> = { ...existing };
            for (const [name, values] of Object.entries(rule)) {
                merged[name] = [
                    ...new Set([...(merged[name] ?? []), ...values]),
                ];
            }
            policy.allow[key] = merged as PolicyRule;
        }
    }
    await writeFile(path, stringify(policy), { encoding: "utf8", mode: 0o600 });
}
