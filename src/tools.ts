import type { CanonicalCapability } from "./capability.js";
import { AwsCliAdapter } from "./adapters/aws.js";
import { GithubCliAdapter } from "./adapters/gh.js";
import { GitCliAdapter } from "./adapters/git.js";
import {
    GithubMcpAdapter,
    matchesGithubMcpCommand,
    matchesGithubMcpUrl,
} from "./adapters/github-mcp.js";
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

export interface Tool<A extends Adapter<unknown>> {
    service: ServiceDefinition;
    adapter: A;
}

export interface CliTool extends Tool<CliAdapter> {
    executable: string;
}

export interface McpTool extends Tool<McpAdapter> {
    matchesCommand(command: readonly string[]): boolean;
    matchesUrl(url: string): boolean;
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

const gitActions = {
    add: [],
    am: [],
    apply: [],
    archive: [],
    bisect: [],
    blame: [],
    branch: [],
    bundle: [],
    checkout: [],
    "cherry-pick": [],
    clean: [],
    clone: [],
    commit: ["paths"],
    push: ["branches"],
    remote: [],
    config: [],
    "symbolic-ref": [],
    status: [],
    log: [],
    diff: [],
    "rev-parse": [],
    describe: [],
    fetch: [],
    grep: [],
    init: [],
    "ls-files": [],
    "ls-remote": [],
    merge: [],
    mv: [],
    pull: [],
    rebase: [],
    reflog: [],
    reset: [],
    restore: [],
    revert: [],
    rm: [],
    show: [],
    stash: [],
    submodule: [],
    switch: [],
    tag: [],
    worktree: [],
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
    "issue.close": ["repos"],
    "issue.delete": ["repos"],
    "issue.develop": ["repos"],
    "issue.lock": ["repos"],
    "issue.pin": ["repos"],
    "issue.reopen": ["repos"],
    "issue.status": ["repos"],
    "issue.transfer": ["repos"],
    "issue.unlock": ["repos"],
    "issue.unpin": ["repos"],
    "pr.checkout": ["repos"],
    "pr.close": ["repos"],
    "pr.comment": ["repos"],
    "pr.lock": ["repos"],
    "pr.ready": ["repos"],
    "pr.reopen": ["repos"],
    "pr.review": ["repos"],
    "pr.unlock": ["repos"],
    "pr.update-branch": ["repos"],
    "repo.archive": [],
    "repo.clone": [],
    "repo.create": [],
    "repo.delete": [],
    "repo.edit": [],
    "repo.fork": [],
    "repo.list": [],
    "repo.rename": [],
    "repo.set-default": [],
    "repo.sync": [],
    "repo.unarchive": [],
    "run.cancel": ["repos"],
    "run.delete": ["repos"],
    "run.download": ["repos"],
    "run.list": ["repos"],
    "run.rerun": ["repos"],
    "run.view": ["repos"],
    "run.watch": ["repos"],
    "workflow.disable": ["repos"],
    "workflow.enable": ["repos"],
    "workflow.list": ["repos"],
    "workflow.run": ["repos"],
    "workflow.view": ["repos"],
    "release.create": ["repos"],
    "release.delete": ["repos"],
    "release.delete-asset": ["repos"],
    "release.download": ["repos"],
    "release.edit": ["repos"],
    "release.list": ["repos"],
    "release.upload": ["repos"],
    "release.view": ["repos"],
    "auth.login": [],
    "auth.logout": [],
    "auth.refresh": [],
    "auth.setup-git": [],
    "auth.status": [],
    "auth.switch": [],
    "auth.token": [],
    "search.code": [],
    "search.commits": [],
    "search.issues": [],
    "search.prs": [],
    "search.repos": [],
    "gist.clone": [],
    "gist.create": [],
    "gist.delete": [],
    "gist.edit": [],
    "gist.list": [],
    "gist.rename": [],
    "gist.view": [],
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
    git: {
        service: services.git,
        adapter: new GitCliAdapter(),
        executable: "git",
    },
    gh: {
        service: services.github,
        adapter: new GithubCliAdapter(),
        executable: "gh",
    },
    aws: {
        service: services.aws,
        adapter: new AwsCliAdapter(),
        executable: "aws",
    },
} satisfies Record<string, CliTool>;

export const mcpTools = {
    github: {
        service: services.github,
        adapter: new GithubMcpAdapter(),
        matchesCommand: matchesGithubMcpCommand,
        matchesUrl: matchesGithubMcpUrl,
    },
} satisfies Record<string, McpTool>;

export type McpToolName = keyof typeof mcpTools;
export type McpAuditToolName = `${McpToolName}-mcp`;

export function isMcpToolName(value: string | undefined): value is McpToolName {
    return value !== undefined && Object.hasOwn(mcpTools, value);
}

export function isMcpAuditToolName(value: string): value is McpAuditToolName {
    return Object.keys(mcpTools).some((name) => value === `${name}-mcp`);
}

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
