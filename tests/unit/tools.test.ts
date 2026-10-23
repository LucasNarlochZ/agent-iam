import { describe, expect, it } from "vitest";
import { parsePolicy } from "../../src/policy/schema.js";
import {
    capabilityDefinitionFor,
    cliTools,
    mcpTools,
    services,
} from "../../src/tools.js";
import {
    gitCommands,
    githubCommands,
    githubAccountCommands,
} from "../support/command-coverage.js";

describe("tool registry", () => {
    it("provides tool and capability metadata from one registry", async () => {
        const { capabilityDefinitionFor, isToolName, toolNames, tools } =
            await import("../../src/tools.js");

        expect(toolNames).toEqual(["git", "gh", "aws"]);
        expect(isToolName("aws")).toBe(true);
        expect(isToolName("unknown")).toBe(false);
        expect(tools.aws.service).toBe(services.aws);
        expect(capabilityDefinitionFor("git.commit")).toMatchObject({
            constraints: ["paths"],
        });
        expect(
            capabilityDefinitionFor("aws.sts.get-caller-identity"),
        ).toMatchObject({ constraints: [] });
        expect(capabilityDefinitionFor("aws.unknown.unknown")).toBeUndefined();
        expect(capabilityDefinitionFor("git.not-a-command")).toBeUndefined();
    });

    it("shares the GitHub service between CLI and MCP tools", () => {
        expect(cliTools.gh.service).toBe(services.github);
        expect(mcpTools.github.service).toBe(services.github);
        expect(
            cliTools.gh.service.capabilityDefinition("github.pr.merge"),
        ).toEqual({
            constraints: ["repos"],
        });
        expect(cliTools.gh).not.toHaveProperty("capabilityDefinition");
        expect(mcpTools.github).not.toHaveProperty("policyConstraints");
    });

    it.each([
        ["git", "git"],
        ["gh", "gh"],
        ["aws", "aws"],
    ] as const)("declares the executable for %s", (name, executable) => {
        expect(cliTools[name].executable).toBe(executable);
    });

    it.each(gitCommands)(
        "supports git %s in normalization and policies",
        async (command) => {
            const normalized = await cliTools.git.adapter.normalize([command], {
                PATH: "",
            });
            expect(normalized.canonical).toBe(`git.${command}`);
            expect(capabilityDefinitionFor(normalized.canonical)).toBeDefined();
            expect(
                parsePolicy(`allow:\n  git.${command}: true\n`).allow[
                    normalized.canonical
                ],
            ).toBe(true);
        },
    );

    it.each(
        Object.entries({ ...githubCommands, ...githubAccountCommands }).flatMap(
            ([group, commands]) => commands.map((command) => [group, command]),
        ),
    )(
        "supports gh %s %s in normalization and policies",
        async (group, command) => {
            const normalized = await cliTools.gh.adapter.normalize(
                [group, command, "--repo", "owner/repo"],
                { PATH: "" },
            );
            expect(normalized.canonical).toBe(`github.${group}.${command}`);
            expect(capabilityDefinitionFor(normalized.canonical)).toEqual({
                constraints:
                    (group in githubCommands && group !== "repo") ||
                    (group === "repo" && command === "view")
                        ? ["repos"]
                        : [],
            });
            expect(
                parsePolicy(`allow:\n  ${normalized.canonical}: true\n`).allow[
                    normalized.canonical
                ],
            ).toBe(true);
        },
    );

    it.each([
        "git.unknown",
        "github.issues.list",
        "github.pr.not-a-command",
        "github.api",
    ])("keeps unsupported capability %s denied", (canonical) => {
        expect(capabilityDefinitionFor(canonical)).toBeUndefined();
        expect(() => parsePolicy(`allow:\n  ${canonical}: true\n`)).toThrow(
            "Unknown capability",
        );
    });
});
