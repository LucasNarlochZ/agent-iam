import type { CanonicalCapability } from "./capability.js";
import { AwsCliAdapter } from "./adapters/aws.js";
import { GithubCliAdapter } from "./adapters/gh.js";
import { GitCliAdapter } from "./adapters/git.js";
import { GithubMcpAdapter } from "./adapters/github-mcp.js";
import type { Adapter, CliAdapter, McpAdapter } from "./adapters/interfaces.js";

export interface CapabilityDefinition {
    constraints: readonly string[];
}

export interface PolicyConstraintValue {
    name: string;
    values: string[];
    label: string;
}

export interface ServiceDefinition {
    service: string;
    capabilityDefinition(canonical: string): CapabilityDefinition | undefined;
    policyConstraints(capability: CanonicalCapability): PolicyConstraintValue[];
}

export interface Tool<A extends Adapter<unknown>> extends ServiceDefinition {
    adapter: A;
}

type ConstraintReader = (
    capability: CanonicalCapability,
) => Omit<PolicyConstraintValue, "name"> | undefined;

function staticService(
    service: string,
    actions: Record<string, readonly string[]>,
    readers: Record<string, ConstraintReader>,
): ServiceDefinition {
    return {
        service,
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

function defineTool<A extends Adapter<unknown>>(
    service: ServiceDefinition,
    adapter: A,
): Tool<A> {
    return { ...service, adapter };
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

export const services = {
    git: staticService("git", gitActions, {
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
    github: staticService("github", githubActions, {
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
        capabilityDefinition(canonical: string) {
            return /^aws\.(?!unknown(?:\.|$))[a-z0-9_-]+\.(?!unknown$)[a-z0-9_-]+$/.test(
                canonical,
            )
                ? { constraints: [] }
                : undefined;
        },
        policyConstraints: () => [],
    },
} satisfies Record<string, ServiceDefinition>;

export const cliTools = {
    git: defineTool(services.git, new GitCliAdapter()),
    gh: defineTool(services.github, new GithubCliAdapter()),
    aws: defineTool(services.aws, new AwsCliAdapter()),
} satisfies Record<string, Tool<CliAdapter>>;

export const mcpTools = {
    github: defineTool(services.github, new GithubMcpAdapter()),
} satisfies Record<string, Tool<McpAdapter>>;

export const tools = cliTools;

export type ToolName = keyof typeof cliTools;

export const toolNames = Object.keys(cliTools) as ToolName[];

export function isToolName(value: string | undefined): value is ToolName {
    return value !== undefined && Object.hasOwn(cliTools, value);
}

export function capabilityDefinitionFor(
    canonical: string,
): CapabilityDefinition | undefined {
    for (const service of Object.values(services)) {
        const definition = service.capabilityDefinition(canonical);
        if (definition) return definition;
    }
    return undefined;
}

export function serviceForCapability(
    capability: CanonicalCapability,
): ServiceDefinition | undefined {
    return Object.values(services).find(
        (service) =>
            service.service === capability.service &&
            service.capabilityDefinition(capability.canonical) !== undefined,
    );
}
