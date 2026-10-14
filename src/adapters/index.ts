import { AwsCliAdapter } from "./aws.js";
import { GithubCliAdapter } from "./gh";
import { GitCliAdapter } from "./git";
import type { CapabilityService } from "../capability.js";
import type { Adapter } from "./interfaces";

export const adapters: Record<string, Adapter<CapabilityService>> = {
    awscli: new AwsCliAdapter(),
    ghcli: new GithubCliAdapter(),
    gitcli: new GitCliAdapter(),
};
