import { capability, type CanonicalCapability } from "../capability.js";
import type { Adapter } from "./interfaces.js";

const valueOptions = new Set([
    "--endpoint-url",
    "--output",
    "--query",
    "--profile",
    "--region",
    "--color",
    "--ca-bundle",
    "--cli-read-timeout",
    "--cli-connect-timeout",
    "--cli-binary-format",
    "--cli-error-format",
]);

const flagOptions = new Set([
    "--debug",
    "--no-verify-ssl",
    "--no-paginate",
    "--version",
    "--no-sign-request",
    "--no-cli-pager",
    "--cli-auto-prompt",
    "--no-cli-auto-prompt",
]);

export class AwsCliAdapter implements Adapter<"aws"> {
    async normalize(args: string[]): Promise<CanonicalCapability<"aws">> {
        let index = 0;
        while (index < args.length) {
            const token = args[index];
            if (!token) break;
            if (valueOptions.has(token)) {
                if (!args[index + 1]) {
                    return capability("aws", "unknown", "unknown");
                }
                index += 2;
                continue;
            }
            if (
                [...valueOptions].some((option) =>
                    token.startsWith(`${option}=`),
                )
            ) {
                index += 1;
                continue;
            }
            if (flagOptions.has(token)) {
                index += 1;
                continue;
            }
            if (token.startsWith("-")) {
                return capability("aws", "unknown", "unknown");
            }
            const service = token;
            const operation = args[index + 1];
            if (!operation || operation.startsWith("-")) {
                return capability("aws", "unknown", service);
            }
            return capability("aws", operation, service);
        }
        return capability("aws", "unknown", "unknown");
    }
}
