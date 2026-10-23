import type { CanonicalCapability } from "../capability.js";
import type {
    Adapter,
    CliAdapter,
    McpAdapter,
} from "../adapters/interfaces.js";

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
