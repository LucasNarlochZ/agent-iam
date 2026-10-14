export type ConstraintValue = string | string[] | number | boolean | undefined;

export interface CanonicalCapability<Service extends string = string> {
    service: Service;
    action: string;
    canonical: string;
    constraints?: Record<string, ConstraintValue>;
}

export function normalizeSegment(value: string): string {
    const segment = value
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return segment || "unknown";
}

export function capability<Service extends string>(
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
    return normalizedSegment
        ? {
              service,
              action: normalizedAction,
              canonical,
          }
        : { service, action: normalizedAction, canonical };
}
