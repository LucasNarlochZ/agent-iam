import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

const registry = {
    git: {
        actions: {
            commit: { constraints: ["paths"] },
            push: { constraints: ["branches"] },
            remote: { constraints: [] },
            config: { constraints: [] },
            "symbolic-ref": { constraints: [] },
            status: { constraints: [] },
            log: { constraints: [] },
            diff: { constraints: [] },
            "rev-parse": { constraints: [] },
        },
    },
    github: {
        actions: {
            "pr.create": { constraints: ["repos"] },
            "pr.merge": { constraints: ["repos"] },
            "pr.view": { constraints: ["repos"] },
            "pr.status": { constraints: ["repos"] },
            "pr.checks": { constraints: ["repos"] },
            "pr.diff": { constraints: ["repos"] },
            "pr.list": { constraints: ["repos"] },
            "repo.view": { constraints: ["repos"] },
        },
    },
} as const;

type ServiceOf = keyof typeof registry;
type ActionOf<S extends ServiceOf> = keyof (typeof registry)[S]["actions"];

type RegisteredCapabilityKey = {
    [S in ServiceOf]: `${S}.${ActionOf<S> & string}`;
}[ServiceOf];

export type CapabilityKey = RegisteredCapabilityKey | `aws.${string}.${string}`;

type DefinitionOf<Key extends CapabilityKey> =
    Key extends `aws.${string}.${string}`
        ? { constraints: readonly [] }
        : Key extends `${infer Service}.${infer Action}`
          ? Service extends ServiceOf
              ? Action extends ActionOf<Service>
                  ? (typeof registry)[Service]["actions"][Action]
                  : never
              : never
          : never;

export type PolicyRule<Key extends CapabilityKey = CapabilityKey> =
    true | Partial<Record<DefinitionOf<Key>["constraints"][number], string[]>>;

export type PolicyRules = Partial<{
    [Key in CapabilityKey]: PolicyRule<Key>;
}>;

export interface Policy {
    allow: PolicyRules;
    deny: PolicyRules;
}

export class PolicyError extends Error {}

function definitionFor(
    capability: string,
): { constraints: readonly string[] } | undefined {
    const [service, ...actionParts] = capability.split(".");
    if (service === "aws") {
        return actionParts.length === 2 &&
            actionParts.every(
                (part) => part !== "unknown" && /^[a-z0-9_-]+$/.test(part),
            )
            ? { constraints: [] }
            : undefined;
    }
    if (service !== "git" && service !== "github") return undefined;
    const action = actionParts.join(".");
    return registry[service].actions[action as never];
}

export function isCapabilityKey(value: string): value is CapabilityKey {
    return definitionFor(value) !== undefined;
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
        const result: Record<string, PolicyRule<CapabilityKey>> = {};
        for (const [capability, rule] of Object.entries(entry)) {
            const definition = definitionFor(capability);
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
            result[capability] = rule as PolicyRule<CapabilityKey>;
        }
        return result as PolicyRules;
    };
    return { allow: readRules("allow"), deny: readRules("deny") };
}

export async function loadPolicy(
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd(),
): Promise<{ policy: Policy; path: string; directoryPolicies: Policy[] }> {
    const path = resolvePolicyPath(env);
    try {
        const policy = parsePolicy(await readFile(path, "utf8"));
        const directoryPolicies: Policy[] = [];
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
        return { policy, path, directoryPolicies };
    } catch (error) {
        if (error instanceof PolicyError)
            throw new PolicyError(`${path}: ${error.message}`);
        throw new PolicyError(
            `${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
