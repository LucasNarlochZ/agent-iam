import { describe, expect, it } from "vitest";
import { gitService } from "../../src/services/git.js";
import { githubService } from "../../src/services/github.js";
import { awsService } from "../../src/services/aws.js";

const services = { git: gitService, github: githubService, aws: awsService };

describe("service definitions", () => {
    it("extracts Git path and branch constraints", () => {
        expect(
            services.git.policyConstraints({
                service: "git",
                action: "commit",
                canonical: "git.commit",
                constraints: { paths: ["src/index.ts"] },
            }),
        ).toEqual([
            {
                name: "paths",
                values: ["src/index.ts"],
                label: "paths src/index.ts",
            },
        ]);
        expect(
            services.git.policyConstraints({
                service: "git",
                action: "push",
                canonical: "git.push",
                constraints: { branches: ["dev"] },
            }),
        ).toEqual([{ name: "branches", values: ["dev"], label: "branch dev" }]);
    });

    it("normalizes GitHub repository policy constraints", () => {
        expect(
            services.github.policyConstraints({
                service: "github",
                action: "merge",
                canonical: "github.pr.merge",
                constraints: { repository: "Acme/App" },
            }),
        ).toEqual([
            {
                name: "repos",
                values: ["acme/app"],
                label: "repository Acme/App",
            },
        ]);
    });

    it("recognizes AWS operations without policy constraints", () => {
        expect(
            services.aws.capabilityDefinition("aws.sts.get-caller-identity"),
        ).toEqual({ constraints: [] });
        expect(
            services.aws.capabilityDefinition("aws.unknown.list"),
        ).toBeUndefined();
        expect(
            services.aws.capabilityDefinition("aws.s3.unknown"),
        ).toBeUndefined();
        expect(services.aws.policyConstraints()).toEqual([]);
    });

    it("does not extract constraints for unsupported or unconstrained actions", () => {
        expect(
            services.git.policyConstraints({
                service: "git",
                action: "unknown",
                canonical: "git.unknown",
                constraints: { paths: ["src/index.ts"] },
            }),
        ).toEqual([]);
        expect(
            services.github.policyConstraints({
                service: "github",
                action: "merge",
                canonical: "github.pr.merge",
            }),
        ).toEqual([]);
    });
});
