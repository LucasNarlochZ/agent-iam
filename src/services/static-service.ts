import type { CanonicalCapability } from "../capability.js";
import type {
    PolicyConstraintValue,
    ServiceDefinition,
} from "../registry/types.js";

type ConstraintReader = (
    capability: CanonicalCapability,
) => Omit<PolicyConstraintValue, "name"> | undefined;

export function staticService(
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
