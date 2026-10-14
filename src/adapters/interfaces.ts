import type { CanonicalCapability } from "../capability.js";

export interface Adapter {
    normalize(
        args: string[],
        env?: NodeJS.ProcessEnv,
    ): CanonicalCapability | Promise<CanonicalCapability>;
}
