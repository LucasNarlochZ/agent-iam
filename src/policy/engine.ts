import pl from "tau-prolog";
import type { CanonicalCapability } from "../capability.js";
import type { CapabilityKey, Policy, PolicyRules } from "./schema.js";
import { compilePolicy, escapePrologAtom } from "./compiler.js";
import { serviceForCapability } from "../tools.js";

export interface PolicyDecision {
    decision: "ALLOW" | "DENY";
    reason: string;
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
): Promise<PolicyDecision> {
    const globalDecision = await evaluatePolicy(globalPolicy, capability);
    if (globalDecision.decision === "DENY") return globalDecision;

    const key = capability.canonical as CapabilityKey;
    for (const policy of directoryPolicies) {
        if (policy.deny[key] !== undefined) {
            const decision = await evaluatePolicy(
                {
                    allow: { [key]: true } as PolicyRules,
                    deny: policy.deny,
                },
                capability,
            );
            if (decision.decision === "DENY") return decision;
        }
        if (policy.allow[key] !== undefined) {
            const decision = await evaluatePolicy(
                { allow: policy.allow, deny: {} },
                capability,
            );
            if (decision.decision === "DENY") return decision;
        }
    }
    return globalDecision;
}
