import type { CanonicalCapability } from "../capability.js";
import { AwsCliAdapter } from "../adapters/aws.js";
import { GithubCliAdapter } from "../adapters/gh.js";
import { GitCliAdapter } from "../adapters/git.js";
import {
    GithubMcpAdapter,
    matchesGithubMcpCommand,
    matchesGithubMcpUrl,
} from "../adapters/github-mcp.js";
import { gitService } from "../services/git.js";
import { githubService } from "../services/github.js";
import { awsService } from "../services/aws.js";
import { ToolRegistry } from "./registry.js";
import type { CapabilityDefinition, ServiceDefinition } from "./types.js";

export const services = {
    git: gitService,
    github: githubService,
    aws: awsService,
} satisfies Record<string, ServiceDefinition>;

export const registry = new ToolRegistry();

for (const service of Object.values(services)) {
    registry.registerService(service);
}

registry.registerCli("git", {
    service: services.git,
    adapter: new GitCliAdapter(),
    executable: "git",
});
registry.registerCli("gh", {
    service: services.github,
    adapter: new GithubCliAdapter(),
    executable: "gh",
});
registry.registerCli("aws", {
    service: services.aws,
    adapter: new AwsCliAdapter(),
    executable: "aws",
});

registry.registerMcp("github", {
    service: services.github,
    adapter: new GithubMcpAdapter(),
    matchesCommand: matchesGithubMcpCommand,
    matchesUrl: matchesGithubMcpUrl,
});

export type McpToolName = string;
export type McpAuditToolName = `${McpToolName}-mcp`;

export function isMcpToolName(value: string | undefined): value is McpToolName {
    return value !== undefined && registry.hasMcp(value);
}

export function isMcpAuditToolName(value: string): value is McpAuditToolName {
    return value.endsWith("-mcp") && registry.hasMcp(value.slice(0, -4));
}

export type ToolName = string;

export function isToolName(value: string | undefined): value is ToolName {
    return value !== undefined && registry.hasCli(value);
}

export function capabilityDefinitionFor(
    canonical: string,
): CapabilityDefinition | undefined {
    return registry.capabilityDefinitionFor(canonical);
}

export function serviceForCapability(
    capability: CanonicalCapability,
): ServiceDefinition | undefined {
    return registry.serviceForCapability(capability);
}
