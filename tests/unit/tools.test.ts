import { describe, expect, it } from "vitest";

describe("tool registry", () => {
    it("provides tool and capability metadata from one registry", async () => {
        const { capabilityDefinitionFor, isToolName, toolNames, tools } =
            await import("../../src/tools.js");

        expect(toolNames).toEqual(["git", "gh", "aws"]);
        expect(isToolName("aws")).toBe(true);
        expect(isToolName("unknown")).toBe(false);
        expect(tools.aws.service).toBe("aws");
        expect(capabilityDefinitionFor("git.commit")).toMatchObject({
            constraints: ["paths"],
        });
        expect(
            capabilityDefinitionFor("aws.sts.get-caller-identity"),
        ).toMatchObject({ constraints: [] });
        expect(capabilityDefinitionFor("aws.unknown.unknown")).toBeUndefined();
        expect(capabilityDefinitionFor("git.clone")).toBeUndefined();
    });
});
