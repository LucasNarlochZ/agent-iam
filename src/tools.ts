import type { CanonicalCapability } from "./capability.js";
import { AwsCliAdapter } from "./adapters/aws.js";
import { GithubCliAdapter } from "./adapters/gh.js";
import { GitCliAdapter } from "./adapters/git.js";
import type { CliAdapter } from "./adapters/interfaces.js";

export interface CapabilityDefinition {
    constraints: readonly string[];
}

export interface PolicyConstraintValue {
    name: string;
    values: string[];
    label: string;
}

interface ToolDefinition {
    service: string;
    adapter: CliAdapter;
    capabilityDefinition(canonical: string): CapabilityDefinition | undefined;
    policyConstraints(capability: CanonicalCapability): PolicyConstraintValue[];
}

type ConstraintReader = (
    capability: CanonicalCapability,
) => Omit<PolicyConstraintValue, "name"> | undefined;

function staticTool(
    service: string,
    adapter: CliAdapter,
    actions: Record<string, readonly string[]>,
    readers: Record<string, ConstraintReader>,
): ToolDefinition {
    return {
        service,
        adapter,
        capabilityDefinition(canonical) {
            const prefix = `${service}.`;
            if (!canonical.startsWith(prefix)) return undefined;
            const action = canonical.slice(prefix.length);
            const constraints = actions[action];
            return constraints ? { constraints } : undefined;
        },
        policyConstraints(capability) {
            const definition = this.capabilityDefinition(capability.canonical);
            if (!definition) return [];
            return definition.constraints.flatMap((name) => {
                const value = readers[name]?.(capability);
                return value ? [{ name, ...value }] : [];
            });
        },
    };
}

const gitActions = {
    commit: ["paths"],
    push: ["branches"],
    remote: [],
    config: [],
    "symbolic-ref": [],
    status: [],
    log: [],
    diff: [],
    "rev-parse": [],
} as const;

const githubActions = {
    "file.read": ["repos"],
    "file.write": ["repos"],
    "issue.list": ["repos"],
    "issue.view": ["repos"],
    "issue.create": ["repos"],
    "issue.edit": ["repos"],
    "issue.comment": ["repos"],
    "pr.create": ["repos"],
    "pr.edit": ["repos"],
    "pr.merge": ["repos"],
    "pr.view": ["repos"],
    "pr.status": ["repos"],
    "pr.checks": ["repos"],
    "pr.diff": ["repos"],
    "pr.list": ["repos"],
    "repo.view": ["repos"],
} as const;

export const tools = {
    git: staticTool("git", new GitCliAdapter(), gitActions, {
        paths: (capability) => {
            const paths = capability.constraints?.paths;
            return Array.isArray(paths) && paths.length > 0
                ? { values: paths, label: `paths ${paths.join(", ")}` }
                : undefined;
        },
        branches: (capability) => {
            const branches = capability.constraints?.branches;
            return Array.isArray(branches) && branches.length > 0
                ? {
                      values: branches,
                      label: `branch ${branches.join(", ")}`,
                  }
                : undefined;
        },
    }),
    gh: staticTool("github", new GithubCliAdapter(), githubActions, {
        repos: (capability) => {
            const repository = capability.constraints?.repository;
            return typeof repository === "string"
                ? {
                      values: [repository.toLowerCase()],
                      label: `repository ${repository}`,
                  }
                : undefined;
        },
    }),
    aws: {
        service: "aws",
        adapter: new AwsCliAdapter(),
        capabilityDefinition(canonical: string) {
            return /^aws\.(?!unknown(?:\.|$))[a-z0-9_-]+\.(?!unknown$)[a-z0-9_-]+$/.test(
                canonical,
            )
                ? { constraints: [] }
                : undefined;
        },
        policyConstraints: () => [],
    },
} satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof tools;

export const toolNames = Object.keys(tools) as ToolName[];

export function isToolName(value: string | undefined): value is ToolName {
    return value !== undefined && Object.hasOwn(tools, value);
}

export function capabilityDefinitionFor(
    canonical: string,
): CapabilityDefinition | undefined {
    for (const tool of Object.values(tools)) {
        const definition = tool.capabilityDefinition(canonical);
        if (definition) return definition;
    }
    return undefined;
}

export function toolForCapability(
    capability: CanonicalCapability,
): ToolDefinition | undefined {
    return Object.values(tools).find(
        (tool) =>
            tool.service === capability.service &&
            tool.capabilityDefinition(capability.canonical) !== undefined,
    );
}
