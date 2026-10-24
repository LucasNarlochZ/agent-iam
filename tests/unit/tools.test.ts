import { describe, expect, it } from "vitest";
import { parsePolicy } from "../../src/policy/schema.js";
import {
    capabilityDefinitionFor,
    registry,
    services,
} from "../../src/registry/builtins.js";
import {
    gitCommands,
    githubCommands,
    githubAccountCommands,
} from "../support/command-coverage.js";

describe("tool registry", () => {
    it("provides tool and capability metadata from one registry", async () => {
        const { capabilityDefinitionFor, isToolName } =
            await import("../../src/registry/builtins.js");

        expect(registry.listCli().map(([name]) => name)).toEqual([
            "git",
            "gh",
            "aws",
        ]);
        expect(isToolName("aws")).toBe(true);
        expect(isToolName("unknown")).toBe(false);
        expect(registry.getCli("aws").service).toBe(services.aws);
        expect(capabilityDefinitionFor("git.commit")).toMatchObject({
            constraints: ["paths", "branches", "force"],
        });
        expect(
            capabilityDefinitionFor("aws.sts.get-caller-identity"),
        ).toMatchObject({ constraints: [] });
        expect(capabilityDefinitionFor("aws.unknown.unknown")).toBeUndefined();
        expect(capabilityDefinitionFor("git.not-a-command")).toBeUndefined();
    });

    it("shares the GitHub service between CLI and MCP tools", () => {
        expect(registry.getCli("gh").service).toBe(services.github);
        expect(registry.getMcp("github").service).toBe(services.github);
        expect(
            registry
                .getCli("gh")
                .service.capabilityDefinition("github.pr.merge"),
        ).toEqual({
            constraints: ["repos"],
        });
        expect(registry.getCli("gh")).not.toHaveProperty(
            "capabilityDefinition",
        );
        expect(registry.getMcp("github")).not.toHaveProperty(
            "policyConstraints",
        );
    });

    it.each([
        ["git", "git"],
        ["gh", "gh"],
        ["aws", "aws"],
    ] as const)("declares the executable for %s", (name, executable) => {
        expect(registry.getCli(name).executable).toBe(executable);
    });

    it.each(gitCommands)(
        "supports git %s in normalization and policies",
        async (command) => {
            const normalized = await registry
                .getCli("git")
                .adapter.normalize([command], {
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
            const normalized = await registry
                .getCli("gh")
                .adapter.normalize([group, command, "--repo", "owner/repo"], {
                    PATH: "",
                });
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
