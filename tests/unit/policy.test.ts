import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parsePolicy } from "../../src/policy/schema.js";
import { compilePolicy, escapePrologAtom } from "../../src/policy/compiler.js";
import {
    buildDecisionGoal,
    evaluatePolicy,
    evaluatePolicies,
    PolicyEngine,
} from "../../src/policy/engine.js";

describe("policy schema", () => {
    it("parses capability-keyed allow and deny rules", () => {
        expect(parsePolicy("allow:\n  git.commit: true\n")).toEqual({
            allow: { "git.commit": true },
            deny: {},
        });
        expect(
            parsePolicy(
                "deny:\n  github.pr.merge:\n    repos:\n      - owner/repo\n",
            ),
        ).toEqual({
            allow: {},
            deny: { "github.pr.merge": { repos: ["owner/repo"] } },
        });
        expect(
            parsePolicy(
                "allow:\n  github.pr.list:\n    repos:\n      - owner/repo\n",
            ),
        ).toEqual({
            allow: { "github.pr.list": { repos: ["owner/repo"] } },
            deny: {},
        });
        expect(
            parsePolicy("allow:\n  aws.sts.get-caller-identity: true\n"),
        ).toEqual({
            allow: { "aws.sts.get-caller-identity": true },
            deny: {},
        });
    });

    it("rejects invalid policy entries", () => {
        expect(() => parsePolicy("allow: git.commit\n")).toThrow(
            "Policy 'allow' must be an object",
        );
        expect(() =>
            parsePolicy("allow:\n  github.pr.unknown: true\n"),
        ).toThrow("Unknown capability 'github.pr.unknown'");
        expect(() =>
            parsePolicy("allow:\n  git.commit:\n    branches:\n      - main\n"),
        ).toThrow("Unknown constraint 'branches' for 'git.commit'");
        expect(() =>
            parsePolicy("allow:\n  git.commit:\n    paths: src/**\n"),
        ).toThrow(
            "Constraint 'paths' for 'git.commit' must be an array of strings",
        );
        expect(() => parsePolicy("allow:\n  git.commit: false\n")).toThrow(
            "Policy rule 'git.commit' in 'allow' must be true or an object",
        );
    });
});

describe("policy compiler", () => {
    it("compiles rules and escapes atoms", () => {
        const program = compilePolicy({
            allow: { "git.commit": true },
            deny: { "github.pr.merge": true },
        });
        expect(program).toContain("allowed('git.commit').");
        expect(program).toContain("denied('github.pr.merge').");
        expect(program).toContain(
            "decision(Capability, Constraints, deny, 'matched deny rule') :- denied(Capability), rule_matches(deny, Capability, Constraints), !.",
        );
        expect(escapePrologAtom("a'b\\c")).toBe("a\\'b\\\\c");
    });
});

describe("policy engine", () => {
    it.each([
        {
            policy: { allow: { "git.add": true as const }, deny: {} },
            canonical: "git.add",
            code: "allow_rule",
            reason: "global allow rule",
        },
        {
            policy: { allow: {}, deny: { "git.add": true as const } },
            canonical: "git.add",
            code: "deny_rule",
            reason: "global deny rule",
        },
        {
            policy: { allow: {}, deny: {} },
            canonical: "git.add",
            code: "no_allow_rule",
            reason: "no allow rule",
        },
        {
            policy: { allow: {}, deny: {} },
            canonical: "git.unknown",
            code: "unsupported_capability",
            reason: "unsupported capability",
        },
        {
            policy: {
                allow: { "git.commit": { paths: ["safe.txt"] } },
                deny: {},
            },
            canonical: "git.commit",
            code: "constraint_mismatch",
            reason: "constraints did not match",
        },
    ])("explains $code", async ({ policy, canonical, code, reason }) => {
        const result = await evaluatePolicies(policy, [], {
            service: "git",
            action: canonical.slice(4),
            canonical,
        });
        expect(result.reasonCode).toBe(code);
        expect(result.reason).toContain(reason);
        expect(result.reason).toContain(canonical);
    });

    it("identifies the directory policy that denied an action", async () => {
        const result = await evaluatePolicies(
            { allow: { "git.add": true }, deny: {} },
            [{ allow: {}, deny: { "git.add": true } }],
            { service: "git", action: "add", canonical: "git.add" },
            {
                global: "/home/user/.agentiam/policy.yaml",
                directories: ["/project/.agentiam/policy.yaml"],
            },
        );
        expect(result).toMatchObject({
            decision: "DENY",
            reasonCode: "deny_rule",
            policyScope: "directory",
            policyPath: "/project/.agentiam/policy.yaml",
        });
        expect(result.reason).toContain("directory deny rule");
    });

    it("delegates the final allow decision to decision/2", () => {
        expect(
            buildDecisionGoal({
                service: "git",
                action: "commit",
                canonical: "git.commit",
            }),
        ).toBe("decision('git.commit', [], Decision, Reason).");
    });

    it("applies allow, deny precedence, and default deny", async () => {
        await expect(
            evaluatePolicy(
                { allow: { "git.commit": true }, deny: {} },
                "git.commit",
            ),
        ).resolves.toEqual({ decision: "ALLOW", reason: "matched allow rule" });
        await expect(
            evaluatePolicy(
                { allow: {}, deny: { "git.push": true } },
                "git.push",
            ),
        ).resolves.toEqual({ decision: "DENY", reason: "matched deny rule" });
        await expect(
            evaluatePolicy(
                { allow: { "git.push": true }, deny: { "git.push": true } },
                "git.push",
            ),
        ).resolves.toEqual({ decision: "DENY", reason: "matched deny rule" });
        await expect(
            evaluatePolicy({ allow: {}, deny: {} }, "git.status"),
        ).resolves.toEqual({
            decision: "DENY",
            reason: "no matching allow rule",
        });
    });

    it("evaluates multiple capabilities with one Prolog session", async () => {
        const engine = new PolicyEngine(
            compilePolicy({
                allow: { "git.commit": true },
                deny: { "git.push": true },
            }),
        );

        await expect(
            engine.evaluate({
                service: "git",
                action: "commit",
                canonical: "git.commit",
            }),
        ).resolves.toEqual({
            decision: "ALLOW",
            reason: "matched allow rule",
        });
        await expect(
            engine.evaluate({
                service: "git",
                action: "push",
                canonical: "git.push",
            }),
        ).resolves.toEqual({
            decision: "DENY",
            reason: "matched deny rule",
        });
    });

    it("enforces repository constraints", async () => {
        const policy = {
            allow: {
                "github.pr.merge": { repos: ["owner/repo"] },
            },
            deny: {},
        };

        await expect(
            evaluatePolicy(policy, {
                service: "github",
                action: "merge",
                canonical: "github.pr.merge",
                constraints: { repository: "owner/repo" },
            }),
        ).resolves.toEqual({ decision: "ALLOW", reason: "matched allow rule" });
        await expect(
            evaluatePolicy(policy, {
                service: "github",
                action: "merge",
                canonical: "github.pr.merge",
                constraints: { repository: "other/repo" },
            }),
        ).resolves.toEqual({
            decision: "DENY",
            reason: "no matching allow rule",
        });
    });

    it("requires every Git path constraint to match the policy", async () => {
        const policy = {
            allow: {
                "git.commit": { paths: ["src/policy.ts"] },
            },
            deny: {},
        };

        await expect(
            evaluatePolicy(policy, {
                service: "git",
                action: "commit",
                canonical: "git.commit",
                constraints: { paths: ["src/policy.ts"] },
            }),
        ).resolves.toEqual({ decision: "ALLOW", reason: "matched allow rule" });
        await expect(
            evaluatePolicy(policy, {
                service: "git",
                action: "commit",
                canonical: "git.commit",
                constraints: { paths: ["src/policy.ts", "README.md"] },
            }),
        ).resolves.toEqual({
            decision: "DENY",
            reason: "no matching allow rule",
        });
    });

    it("allows gh pr view in the example policy", async () => {
        const source = await readFile(
            new URL("../../examples/policy.yaml", import.meta.url),
            "utf8",
        );
        const policy = parsePolicy(source);

        await expect(evaluatePolicy(policy, "github.pr.view")).resolves.toEqual(
            { decision: "ALLOW", reason: "matched allow rule" },
        );
    });

    it("allows configured git commands in the example policy", async () => {
        const source = await readFile(
            new URL("../../examples/policy.yaml", import.meta.url),
            "utf8",
        );
        const policy = parsePolicy(source);
        const capabilities = ["git.remote", "git.config", "git.symbolic-ref"];

        for (const capability of capabilities) {
            await expect(evaluatePolicy(policy, capability)).resolves.toEqual({
                decision: "ALLOW",
                reason: "matched allow rule",
            });
        }
    });

    it("applies AWS rules in the example policy", async () => {
        const source = await readFile(
            new URL("../../examples/policy.yaml", import.meta.url),
            "utf8",
        );
        const policy = parsePolicy(source);

        await expect(
            evaluatePolicy(policy, "aws.sts.get-caller-identity"),
        ).resolves.toEqual({
            decision: "ALLOW",
            reason: "matched allow rule",
        });
        await expect(evaluatePolicy(policy, "aws.s3.rm")).resolves.toEqual({
            decision: "DENY",
            reason: "matched deny rule",
        });
    });
});
