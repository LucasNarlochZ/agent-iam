import { writeFile } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";
import { stringify } from "yaml";
import type { CanonicalCapability } from "./capability.js";
import type { CapabilityKey, Policy, PolicyRule } from "./policy/schema.js";
import { toolForCapability } from "./tools.js";

export type ApprovalChoice = "allow" | "allow-context" | "deny" | "skip";

export interface ApprovalOption {
    label: string;
    value: ApprovalChoice;
}

export function selectWithArrowKeys(
    message: string,
    choices: readonly ApprovalOption[],
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WritableStream = process.stderr,
): Promise<ApprovalChoice> {
    return new Promise((resolve) => {
        let selected = 0;
        const wasRaw = input.isRaw;
        const render = (moveUp: boolean) => {
            if (moveUp) output.write(`\u001B[${choices.length}A`);
            for (const [index, choice] of choices.entries()) {
                output.write(
                    `\r\u001B[2K${index === selected ? "❯" : " "} ${choice.label}\n`,
                );
            }
        };
        const finish = (choice: ApprovalChoice) => {
            input.off("keypress", onKeypress);
            input.setRawMode(wasRaw);
            input.pause();
            output.write("\n");
            resolve(choice);
        };
        const onKeypress = (
            _sequence: string,
            key: { name?: string; ctrl?: boolean },
        ) => {
            if (key.name === "up") {
                selected = (selected - 1 + choices.length) % choices.length;
                render(true);
            } else if (key.name === "down") {
                selected = (selected + 1) % choices.length;
                render(true);
            } else if (key.name === "return") {
                finish(choices[selected]!.value);
            } else if (
                key.name === "escape" ||
                (key.ctrl && key.name === "c")
            ) {
                finish(choices.find(({ value }) => value === "skip")!.value);
            }
        };

        output.write(`${message}\n`);
        render(false);
        emitKeypressEvents(input);
        input.setRawMode(true);
        input.on("keypress", onKeypress);
        input.resume();
    });
}

export interface ApprovalPromptOptions {
    isTTY?: boolean;
    select?: (
        message: string,
        choices: readonly ApprovalOption[],
    ) => Promise<ApprovalChoice>;
}

function contextLabel(capability: CanonicalCapability): string | undefined {
    const labels =
        toolForCapability(capability)
            ?.policyConstraints(capability)
            .map(({ label }) => label) ?? [];
    return labels.length > 0 ? labels.join("; ") : undefined;
}

export async function requestApproval(
    capability: CanonicalCapability,
    options: ApprovalPromptOptions = {},
): Promise<ApprovalChoice> {
    const isTTY =
        options.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
    if (!isTTY) return "skip";

    const context = contextLabel(capability);
    const choices: ApprovalOption[] = [
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
    return (options.select ?? selectWithArrowKeys)(
        `[agentiam] ${capability.canonical} was denied.`,
        choices,
    );
}

function contextualRule(
    capability: CanonicalCapability,
): PolicyRule | undefined {
    const constraints =
        toolForCapability(capability)?.policyConstraints(capability) ?? [];
    return constraints.length > 0
        ? Object.fromEntries(
              constraints.map(({ name, values }) => [name, values]),
          )
        : undefined;
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
