import { basename } from "node:path";
import { claudeHarnessAdapter } from "./claude.js";
import { codexHarnessAdapter } from "./codex.js";
import { opencodeHarnessAdapter } from "./opencode.js";

export interface HarnessAdapter {
    nativeApprovals: boolean;
    commandArgs(args: string[], env: NodeJS.ProcessEnv): string[];
    prepare?(
        env: NodeJS.ProcessEnv,
        directory: string,
        command?: string,
        version?: string,
    ): void | Promise<void>;
}

export interface HarnessDefinition {
    matches(command: string): boolean;
    adapter: HarnessAdapter;
}

export const genericHarnessAdapter: HarnessAdapter = {
    nativeApprovals: false,
    commandArgs: (args) => args,
};

export { claudeHarnessAdapter, codexHarnessAdapter, opencodeHarnessAdapter };

export const harnesses: Record<string, HarnessDefinition> = {
    opencode: {
        matches: (command) => basename(command) === "opencode",
        adapter: opencodeHarnessAdapter,
    },
    codex: {
        matches: (command) => basename(command) === "codex",
        adapter: codexHarnessAdapter,
    },
    claude: {
        matches: (command) => basename(command) === "claude",
        adapter: claudeHarnessAdapter,
    },
};

export function getHarnessAdapter(
    command: string,
    registry: Record<string, HarnessDefinition> = harnesses,
): HarnessAdapter {
    return (
        Object.values(registry).find(({ matches }) => matches(command))
            ?.adapter ?? genericHarnessAdapter
    );
}
