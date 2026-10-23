import type { ServiceDefinition } from "../registry/types.js";

export const awsService = {
    service: "aws",
    capabilityDefinition(canonical: string) {
        return /^aws\.(?!unknown(?:\.|$))[a-z0-9_-]+\.(?!unknown$)[a-z0-9_-]+$/.test(
            canonical,
        )
            ? { constraints: [] }
            : undefined;
    },
    policyConstraints: () => [],
} satisfies ServiceDefinition;
