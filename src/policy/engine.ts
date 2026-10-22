import pl from "tau-prolog";
import type { CanonicalCapability } from "../capability.js";
import type { CapabilityKey, Policy, PolicyRules } from "./schema.js";
import { compilePolicy, escapePrologAtom } from "./compiler.js";
import { capabilityDefinitionFor, serviceForCapability } from "../tools.js";

export interface PolicyDecision {
    decision: "ALLOW" | "DENY";
    reason: string;
    reasonCode?: string;
    policyScope?: "global" | "directory";
    policyPath?: string;
}

export class PolicyEngineError extends Error {}

type Session = ReturnType<typeof pl.create>;

function constraintTerms(capability: CanonicalCapability): string {
    const constraints = (
        serviceForCapability(capability)?.policyConstraints(capability) ?? []
    ).flatMap(({ name, values }) =>
        values.map(
            (value) => `constraint(${name}, '${escapePrologAtom(value)}')`,
        ),
    );
    return `[${constraints.join(", ")}]`;
}

export function buildDecisionGoal(capability: CanonicalCapability): string {
    return `decision('${escapePrologAtom(capability.canonical)}', ${constraintTerms(capability)}, Decision, Reason).`;
}

function consult(session: Session, program: string): Promise<void> {
    return new Promise((resolve, reject) => {
        session.consult(program, {
            success: () => resolve(),
            error: (error) => reject(new PolicyEngineError(String(error))),
        });
    });
}

function query(session: Session, goal: string): Promise<PolicyDecision> {
    return new Promise((resolve, reject) => {
        session.query(goal, {
            success: () =>
                session.answer({
                    success: (answer) => {
                        const formatted = session.format_answer(answer);
                        const match = formatted.match(
                            /Decision = (allow|deny), Reason = (.+)$/,
                        );
                        if (!match) {
                            reject(
                                new PolicyEngineError(
                                    `Unexpected Prolog answer: ${formatted}`,
                                ),
                            );
                            return;
                        }
                        resolve({
                            decision: match[1] === "allow" ? "ALLOW" : "DENY",
                            reason: match[2]!.trim(),
                        });
                    },
                    fail: () =>
                        reject(
                            new PolicyEngineError(
                                "Prolog returned no decision",
                            ),
                        ),
                    error: (error) =>
                        reject(new PolicyEngineError(String(error))),
                    limit: () =>
                        reject(
                            new PolicyEngineError(
                                "Prolog inference limit exceeded",
                            ),
                        ),
                }),
            error: (error) => reject(new PolicyEngineError(String(error))),
        });
    });
}

export class PolicyEngine {
    private readonly session = pl.create(1000);
    private readonly ready: Promise<void>;

    constructor(compiledFacts: string) {
        this.ready = consult(this.session, compiledFacts);
    }

    async evaluate(capability: CanonicalCapability): Promise<PolicyDecision> {
        await this.ready;
        return query(this.session, buildDecisionGoal(capability));
    }
}

export function evaluatePolicy(
    policy: Policy,
    capability: CanonicalCapability | string,
): Promise<PolicyDecision> {
    const normalized =
        typeof capability === "string"
            ? {
                  service: "git" as const,
                  action: "unknown",
                  canonical: capability,
              }
            : capability;
    return new PolicyEngine(compilePolicy(policy)).evaluate(normalized);
}

export async function evaluatePolicies(
    globalPolicy: Policy,
    directoryPolicies: Policy[],
    capability: CanonicalCapability,
    paths?: { global: string; directories: string[] },
): Promise<PolicyDecision> {
    const explain = (
        decision: PolicyDecision,
        policy: Policy,
        scope: "global" | "directory",
        path?: string,
    ): PolicyDecision => {
        const key = capability.canonical;
        let reasonCode: string;
        let reason: string;
        if (!capabilityDefinitionFor(key)) {
            reasonCode = "unsupported_capability";
            reason = `unsupported capability ${key}; no policy rule can authorize it`;
        } else if (
            decision.reason === "matched deny rule" ||
            decision.decision === "ALLOW"
        ) {
            const effect = decision.decision === "ALLOW" ? "allow" : "deny";
            reasonCode = `${effect}_rule`;
            const rule = policy[effect][key];
            reason = `matched ${scope} ${effect} rule for ${key}${rule !== true ? ` with constraints ${JSON.stringify(rule)}` : ""}`;
        } else if (policy.allow[key] !== undefined) {
            reasonCode = "constraint_mismatch";
            reason = `${scope} allow rule constraints did not match for ${key}; expected ${JSON.stringify(policy.allow[key])}; actual ${JSON.stringify(capability.constraints ?? {})}`;
        } else {
            reasonCode = "no_allow_rule";
            reason = `no allow rule for ${key} in ${scope} policy (default deny)`;
        }
        return {
            decision: decision.decision,
            reason,
            reasonCode,
            policyScope: scope,
            ...(path ? { policyPath: path } : {}),
        };
    };
    const globalDecision = explain(
        await evaluatePolicy(globalPolicy, capability),
        globalPolicy,
        "global",
        paths?.global,
    );
    if (globalDecision.decision === "DENY") return globalDecision;

    const key = capability.canonical as CapabilityKey;
    for (const [index, policy] of directoryPolicies.entries()) {
        if (policy.deny[key] !== undefined) {
            const decision = await evaluatePolicy(
                {
                    allow: { [key]: true } as PolicyRules,
                    deny: policy.deny,
                },
                capability,
            );
            if (decision.decision === "DENY")
                return explain(
                    decision,
                    policy,
                    "directory",
                    paths?.directories[index],
                );
        }
        if (policy.allow[key] !== undefined) {
            const decision = await evaluatePolicy(
                { allow: policy.allow, deny: {} },
                capability,
            );
            if (decision.decision === "DENY")
                return explain(
                    decision,
                    policy,
                    "directory",
                    paths?.directories[index],
                );
        }
    }
    return globalDecision;
}
