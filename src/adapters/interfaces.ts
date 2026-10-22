import type { CanonicalCapability } from "../capability.js";

export interface Adapter<Input> {
    normalize(
        input: Input,
    ):
        | CanonicalCapability
        | undefined
        | Promise<CanonicalCapability | undefined>;
}

export type CliInput = string[];

export interface CliAdapter extends Adapter<CliInput> {
    normalize(
        args: CliInput,
        env?: NodeJS.ProcessEnv,
    ): CanonicalCapability | Promise<CanonicalCapability>;
}

export interface McpToolCall {
    name: string;
    arguments?: Record<string, unknown>;
}

export interface McpAdapter extends Adapter<McpToolCall> {
    supportsTool(name: string): boolean;
}
