import type { Policy } from "./schema.js";

export function escapePrologAtom(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function compilePolicy(policy: Policy): string {
    const allowed = Object.keys(policy.allow).map(
        (value) => `allowed('${escapePrologAtom(value)}').`,
    );
    const denied = Object.keys(policy.deny).map(
        (value) => `denied('${escapePrologAtom(value)}').`,
    );
    const constraints = (["allow", "deny"] as const).flatMap((kind) =>
        Object.entries(policy[kind]).flatMap(([capability, rule]) => {
            if (!rule || rule === true) return [];
            return Object.entries(rule).flatMap(([name, values]) =>
                values.map((value) => {
                    const normalized =
                        capability.startsWith("github.") && name === "repos"
                            ? value.toLowerCase()
                            : value;
                    return `rule_constraint(${kind}, '${escapePrologAtom(capability)}', ${name}, '${escapePrologAtom(normalized)}').`;
                }),
            );
        }),
    );
    if (allowed.length === 0) allowed.push("allowed('__agentiam_never__').");
    if (denied.length === 0) denied.push("denied('__agentiam_never__').");
    if (constraints.length === 0) {
        constraints.push(
            "rule_constraint(none, '__agentiam_never__', none, none).",
        );
    }
    return [
        ...allowed,
        ...denied,
        ...constraints,
        "rule_matches(Kind, Capability, _) :- \\+ rule_constraint(Kind, Capability, _, _), !.",
        "constraint_member(Value, [Value|_]).",
        "constraint_member(Value, [_|Tail]) :- constraint_member(Value, Tail).",
        "constraint_matches(Kind, Capability, Constraint, Constraints) :- constraint_member(constraint(Constraint, _), Constraints), \\+ (constraint_member(constraint(Constraint, Value), Constraints), \\+ rule_constraint(Kind, Capability, Constraint, Value)).",
        "rule_matches(Kind, Capability, Constraints) :- \\+ (rule_constraint(Kind, Capability, Constraint, _), \\+ constraint_matches(Kind, Capability, Constraint, Constraints)).",
        "decision(Capability, Constraints, deny, 'matched deny rule') :- denied(Capability), rule_matches(deny, Capability, Constraints), !.",
        "decision(Capability, Constraints, allow, 'matched allow rule') :- allowed(Capability), rule_matches(allow, Capability, Constraints), !.",
        "decision(_, _, deny, 'no matching allow rule').",
    ].join("\n");
}
