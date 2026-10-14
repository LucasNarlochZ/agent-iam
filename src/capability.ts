export interface ConstraintMap {
    aws: Record<string, never>;
    git: {
        paths?: string[];
        branches?: string[];
    };
    github: {
        repository?: string;
        pullRequest?: number;
    };
}

export type CapabilityService = keyof ConstraintMap;

export type CanonicalCapability<
    Service extends CapabilityService = CapabilityService,
> = {
    [Key in Service]: {
        service: Key;
        action: string;
        canonical: string;
        constraints?: ConstraintMap[Key];
    };
}[Service];

export function normalizeSegment(value: string): string {
    const segment = value
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return segment || "unknown";
}

export function capability<Service extends CapabilityService>(
    service: Service,
    action: string,
    segment?: string,
): CanonicalCapability<Service> {
    const normalizedAction = normalizeSegment(action);
    const normalizedSegment =
        segment === undefined ? undefined : normalizeSegment(segment);
    const canonical = normalizedSegment
        ? `${service}.${normalizedSegment}.${normalizedAction}`
        : `${service}.${normalizedAction}`;
    return (
        normalizedSegment
            ? {
                  service,
                  action: normalizedAction,
                  canonical,
              }
            : { service, action: normalizedAction, canonical }
    ) as CanonicalCapability<Service>;
}
