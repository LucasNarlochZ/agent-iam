import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { stringify } from "yaml";
import type { CanonicalCapability } from "../capability.js";
import type { CapabilityKey, Policy, PolicyRule } from "../policy/schema.js";
import { parsePolicy, resolvePolicyPath } from "../policy/schema.js";
import { serviceForCapability } from "../registry/builtins.js";

export type ApprovalChoice =
    "allow" | "allow-context" | "allow-once" | "deny" | "deny-context" | "skip";

export type ApprovalDecision =
    | ApprovalChoice
    | {
          choice: ApprovalChoice;
          scope?: string[];
          policyPath?: string;
      };

export interface ApprovalContext {
    cwd: string;
    globalPolicyPath: string;
}

export function approvalChoice(decision: ApprovalDecision): ApprovalChoice {
    return typeof decision === "string" ? decision : decision.choice;
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
    const valid = (choice: unknown) =>
        typeof choice === "string" &&
        [
            "allow",
            "allow-context",
            "allow-once",
            "deny",
            "deny-context",
            "skip",
        ].includes(choice);
    if (typeof value === "string") return valid(value);
    if (!value || typeof value !== "object") return false;
    const decision = value as Record<string, unknown>;
    return (
        valid(decision.choice) &&
        (decision.scope === undefined ||
            (Array.isArray(decision.scope) &&
                decision.scope.length > 0 &&
                decision.scope.every((name) => typeof name === "string"))) &&
        (decision.policyPath === undefined ||
            typeof decision.policyPath === "string")
    );
}

export interface ApprovalOption {
    label: string;
    value: string;
}

export function approvalMessage(capability: CanonicalCapability): string {
    return `[agentiam] ${capability.canonical} was denied.`;
}

export function selectWithArrowKeys(
    message: string,
    choices: readonly ApprovalOption[],
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
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
        const finish = (choice: string) => {
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
                finish("skip");
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
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    context?: ApprovalContext;
    select?: (
        message: string,
        choices: readonly ApprovalOption[],
    ) => Promise<string>;
}

export interface ApprovalPlan {
    message: string;
    scopes: Array<ApprovalOption & { constraints: string[] }>;
    policies: ApprovalOption[];
}

export function approvalOptions(
    _capability?: CanonicalCapability,
): ApprovalOption[] {
    return [
        { label: "Allow permanently", value: "allow" },
        { label: "Allow once", value: "allow-once" },
        { label: "Deny permanently", value: "deny" },
        { label: "Skip", value: "skip" },
    ];
}

export async function createApprovalPlan(
    capability: CanonicalCapability,
    context: ApprovalContext = {
        cwd: process.cwd(),
        globalPolicyPath: resolvePolicyPath(),
    },
): Promise<ApprovalPlan> {
    const constraints =
        serviceForCapability(capability)?.policyConstraints(capability) ?? [];
    const scopes = constraints.map(({ name, label }) => ({
        label: `Only for ${label}`,
        value: name,
        constraints: [name],
    }));
    if (constraints.length > 1)
        scopes.unshift({
            label: `Only for this context (${constraints.map(({ label }) => label).join("; ")})`,
            value: "context",
            constraints: constraints.map(({ name }) => name),
        });
    const local = join(resolve(context.cwd), ".agentiam", "policy.yaml");
    let hasLocal = false;
    if (local !== resolve(context.globalPolicyPath)) {
        try {
            hasLocal = (await stat(local)).isFile();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    return {
        message: approvalMessage(capability),
        scopes,
        policies: hasLocal
            ? [
                  {
                      label: `Global policy (${resolve(context.globalPolicyPath)})`,
                      value: resolve(context.globalPolicyPath),
                  },
                  { label: `Local policy (${local})`, value: local },
              ]
            : [],
    };
}

export async function selectApproval(
    plan: ApprovalPlan,
    select: NonNullable<ApprovalPromptOptions["select"]>,
): Promise<ApprovalDecision> {
    const choice = await select(plan.message, approvalOptions());
    if (choice === "allow-once" || choice === "skip") return choice;
    if (choice !== "allow" && choice !== "deny") return "skip";
    let scope: string[] | undefined;
    if (plan.scopes.length) {
        const selected = await select("Apply this action to which scope?", [
            { label: "All contexts of this action", value: "all" },
            ...plan.scopes,
        ]);
        if (selected !== "all") {
            scope = plan.scopes.find(
                ({ value }) => value === selected,
            )?.constraints;
            if (!scope) return "skip";
        }
    }
    let policyPath: string | undefined;
    if (plan.policies.length) {
        const selected = await select(
            "Save the rule in which policy?",
            plan.policies,
        );
        policyPath = plan.policies.find(
            ({ value }) => value === selected,
        )?.value;
        if (!policyPath) return "skip";
    }
    if (!scope && !policyPath) return choice;
    return {
        choice: scope ? `${choice}-context` : choice,
        ...(scope ? { scope } : {}),
        ...(policyPath ? { policyPath } : {}),
    };
}

export async function requestApproval(
    capability: CanonicalCapability,
    options: ApprovalPromptOptions = {},
): Promise<ApprovalDecision> {
    const isTTY =
        options.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
    if (!isTTY) return "skip";

    return selectApproval(
        await createApprovalPlan(
            capability,
            options.context ?? {
                cwd: options.cwd ?? process.cwd(),
                globalPolicyPath: resolvePolicyPath(options.env),
            },
        ),
        options.select ?? selectWithArrowKeys,
    );
}

function contextualRule(
    capability: CanonicalCapability,
    scope?: string[],
): PolicyRule | undefined {
    const constraints =
        serviceForCapability(capability)?.policyConstraints(capability) ?? [];
    if (
        scope?.some(
            (name) =>
                !constraints.some((constraint) => constraint.name === name),
        )
    ) {
        throw new Error("Invalid approval scope");
    }
    const selected = scope
        ? constraints.filter(({ name }) => scope.includes(name))
        : constraints;
    return selected.length > 0
        ? Object.fromEntries(selected.map(({ name, values }) => [name, values]))
        : undefined;
}

export async function persistApproval(
    path: string,
    policy: Policy,
    capability: CanonicalCapability,
    decision: ApprovalDecision,
): Promise<void> {
    const choice = approvalChoice(decision);
    if (choice === "skip" || choice === "allow-once") return;
    const key = capability.canonical as CapabilityKey;
    const rules =
        choice === "deny" || choice === "deny-context"
            ? policy.deny
            : policy.allow;
    if (choice === "deny" || choice === "allow") {
        rules[key] = true;
    } else {
        const rule = contextualRule(
            capability,
            typeof decision === "string" ? undefined : decision.scope,
        );
        if (!rule) return;
        const existing = rules[key];
        if (existing !== true) {
            const merged: Record<string, string[]> = { ...existing };
            for (const [name, values] of Object.entries(rule)) {
                merged[name] = [
                    ...new Set([...(merged[name] ?? []), ...values]),
                ];
            }
            rules[key] = merged as PolicyRule;
        }
    }
    await writeFile(path, stringify(policy), { encoding: "utf8", mode: 0o600 });
}

export async function persistApprovalDecision(
    context: ApprovalContext,
    capability: CanonicalCapability,
    decision: ApprovalDecision,
): Promise<string> {
    const path =
        typeof decision === "string"
            ? context.globalPolicyPath
            : (decision.policyPath ?? context.globalPolicyPath);
    if (["skip", "allow-once"].includes(approvalChoice(decision)))
        return context.globalPolicyPath;
    const plan = await createApprovalPlan(capability, context);
    if (
        resolve(path) !== resolve(context.globalPolicyPath) &&
        !plan.policies.some(({ value }) => value === resolve(path))
    ) {
        throw new Error("Invalid approval policy target");
    }
    const policy = parsePolicy(await readFile(path, "utf8"));
    await persistApproval(path, policy, capability, decision);
    return path;
}
