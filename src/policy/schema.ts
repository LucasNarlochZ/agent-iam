import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { capabilityDefinitionFor } from "../tools.js";

export type CapabilityKey = string;
export type PolicyRule = true | Record<string, string[]>;
export type PolicyRules = Partial<Record<CapabilityKey, PolicyRule>>;

export interface Policy {
    allow: PolicyRules;
    deny: PolicyRules;
}

export class PolicyError extends Error {}

export function isCapabilityKey(value: string): value is CapabilityKey {
    return capabilityDefinitionFor(value) !== undefined;
}

export function resolvePolicyPath(
    env: NodeJS.ProcessEnv = process.env,
): string {
    return `${env.HOME ?? homedir()}/.agentiam/policy.yaml`;
}

export function parsePolicy(source: string): Policy {
    let value: unknown;
    try {
        value = parse(source) as unknown;
    } catch (error) {
        throw new PolicyError(
            `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new PolicyError("Policy root must be an object");
    const root = value as Record<string, unknown>;
    for (const key of Object.keys(root)) {
        if (key !== "allow" && key !== "deny")
            throw new PolicyError(`Unknown policy key '${key}'`);
    }
    const readRules = (key: "allow" | "deny"): PolicyRules => {
        const entry = root[key];
        if (entry === undefined) return {};
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw new PolicyError(`Policy '${key}' must be an object`);
        const result: Record<string, PolicyRule> = {};
        for (const [capability, rule] of Object.entries(entry)) {
            const definition = capabilityDefinitionFor(capability);
            if (!definition)
                throw new PolicyError(`Unknown capability '${capability}'`);
            if (rule === true) {
                result[capability] = true;
                continue;
            }
            if (!rule || typeof rule !== "object" || Array.isArray(rule))
                throw new PolicyError(
                    `Policy rule '${capability}' in '${key}' must be true or an object`,
                );
            for (const [name, values] of Object.entries(rule)) {
                if (!definition.constraints.includes(name))
                    throw new PolicyError(
                        `Unknown constraint '${name}' for '${capability}'`,
                    );
                if (
                    !Array.isArray(values) ||
                    values.some((value) => typeof value !== "string")
                )
                    throw new PolicyError(
                        `Constraint '${name}' for '${capability}' must be an array of strings`,
                    );
            }
            result[capability] = rule as PolicyRule;
        }
        return result as PolicyRules;
    };
    return { allow: readRules("allow"), deny: readRules("deny") };
}

export async function loadPolicy(
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
): Promise<{
    policy: Policy;
    path: string;
    directoryPolicies: Policy[];
    directoryPolicyPaths: string[];
}> {
    const path = resolvePolicyPath(env);
    try {
        const policy = parsePolicy(await readFile(path, "utf8"));
        const directoryPolicies: Policy[] = [];
        const directoryPolicyPaths: string[] = [];
        const globalPath = resolve(path);
        let directory = resolve(cwd);
        while (true) {
            const directoryPolicyPath = join(
                directory,
                ".agentiam",
                "policy.yaml",
            );
            if (directoryPolicyPath !== globalPath) {
                try {
                    directoryPolicies.unshift(
                        parsePolicy(
                            await readFile(directoryPolicyPath, "utf8"),
                        ),
                    );
                    directoryPolicyPaths.unshift(directoryPolicyPath);
                } catch (error) {
                    if (!(
                        error instanceof Error &&
                        "code" in error &&
                        error.code === "ENOENT"
                    )) {
                        throw new PolicyError(
                            `${directoryPolicyPath}: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                }
            }
            const parent = dirname(directory);
            if (parent === directory) break;
            directory = parent;
        }
        return { policy, path, directoryPolicies, directoryPolicyPaths };
    } catch (error) {
        if (error instanceof PolicyError)
            throw new PolicyError(`${path}: ${error.message}`);
        throw new PolicyError(
            `${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
