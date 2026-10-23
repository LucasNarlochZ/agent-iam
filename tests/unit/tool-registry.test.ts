import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/registry/registry.js";
import { GithubCliAdapter } from "../../src/adapters/gh.js";
import { GithubMcpAdapter } from "../../src/adapters/github-mcp.js";
import {
    services,
    registry,
    isToolName,
    isMcpToolName,
    isMcpAuditToolName,
    capabilityDefinitionFor,
    serviceForCapability,
} from "../../src/tools.js";
import { proxyMcpCommand, checkMcpUrl } from "../../src/mcp-configuration.js";
import { parsePolicy } from "../../src/policy/schema.js";

describe("ToolRegistry", () => {
    it("registers services and resolves their capabilities", () => {
        const registry = new ToolRegistry();
        expect(
            registry.capabilityDefinitionFor("github.pr.merge"),
        ).toBeUndefined();
        registry.registerService(services.github);
        expect(registry.capabilityDefinitionFor("github.pr.merge")).toEqual({
            constraints: ["repos"],
        });
        expect(
            registry.serviceForCapability({
                service: "github",
                action: "merge",
                canonical: "github.pr.merge",
            }),
        ).toBe(services.github);
        expect(
            registry.serviceForCapability({
                service: "git",
                action: "merge",
                canonical: "github.pr.merge",
            }),
        ).toBeUndefined();
        expect(
            registry.serviceForCapability({
                service: "github",
                action: "unknown",
                canonical: "github.unknown",
            }),
        ).toBeUndefined();
        expect(() => registry.registerService(services.github)).toThrow(
            "Duplicate service: github",
        );
    });

    it("registers CLI tools dynamically and keeps registry instances isolated", () => {
        const registry = new ToolRegistry();
        const tool = {
            service: services.github,
            adapter: new GithubCliAdapter(),
            executable: "gh",
        };
        expect(registry.listCli()).toEqual([]);
        expect(registry.hasCli("custom-gh")).toBe(false);
        expect(() => registry.getCli("custom-gh")).toThrow(
            "Unknown CLI tool: custom-gh",
        );
        registry.registerCli("custom-gh", tool);
        expect(registry.getCli("custom-gh")).toBe(tool);
        expect(registry.hasCli("custom-gh")).toBe(true);
        expect(registry.listCli()).toEqual([["custom-gh", tool]]);
        expect(new ToolRegistry().hasCli("custom-gh")).toBe(false);
        const replacement = { ...tool, executable: "gh-custom" };
        registry.registerCli("custom-gh", replacement);
        expect(registry.getCli("custom-gh")).toBe(replacement);
    });

    it("registers MCP tools independently of CLI tools", () => {
        const registry = new ToolRegistry();
        const tool = {
            service: services.github,
            adapter: new GithubMcpAdapter(),
            matchesCommand: (command: readonly string[]) =>
                command[0] === "custom-mcp",
            matchesUrl: (url: string) => url === "https://example.com/mcp",
        };
        expect(registry.listMcp()).toEqual([]);
        expect(registry.hasMcp("custom")).toBe(false);
        expect(() => registry.getMcp("custom")).toThrow(
            "Unknown MCP tool: custom",
        );
        registry.registerMcp("custom", tool);
        expect(registry.getMcp("custom")).toBe(tool);
        expect(registry.hasMcp("custom")).toBe(true);
        expect(registry.hasCli("custom")).toBe(false);
        expect(registry.listMcp()).toEqual([["custom", tool]]);
        const replacement = { ...tool };
        registry.registerMcp("custom", replacement);
        expect(registry.getMcp("custom")).toBe(replacement);
    });

    it("exposes late registrations to policy validation and MCP discovery", () => {
        const service = {
            service: "custom",
            capabilityDefinition: (canonical: string) =>
                canonical === "custom.read" ? { constraints: [] } : undefined,
            policyConstraints: () => [],
        };
        expect(isToolName("custom-cli")).toBe(false);
        expect(isMcpToolName("custom-mcp-server")).toBe(false);
        expect(capabilityDefinitionFor("custom.read")).toBeUndefined();
        registry.registerService(service);
        registry.registerCli("custom-cli", {
            service,
            executable: "custom",
            adapter: {
                normalize: () => ({
                    service: "custom",
                    action: "read",
                    canonical: "custom.read",
                }),
            },
        });
        registry.registerMcp("custom-mcp-server", {
            service,
            adapter: {
                normalize: () => ({
                    service: "custom",
                    action: "read",
                    canonical: "custom.read",
                }),
                supportsTool: (name) => name === "read",
            },
            matchesCommand: (command) => command[0] === "custom-mcp",
            matchesUrl: (url) => url === "https://example.com/custom-mcp",
        });
        expect(isToolName("custom-cli")).toBe(true);
        expect(isMcpToolName("custom-mcp-server")).toBe(true);
        expect(isMcpAuditToolName("custom-mcp-server-mcp")).toBe(true);
        expect(registry.listCli().map(([name]) => name)).toContain(
            "custom-cli",
        );
        expect(capabilityDefinitionFor("custom.read")).toEqual({
            constraints: [],
        });
        expect(
            serviceForCapability({
                service: "custom",
                action: "read",
                canonical: "custom.read",
            }),
        ).toBe(service);
        expect(
            parsePolicy("allow:\n  custom.read: true\n").allow["custom.read"],
        ).toBe(true);
        expect(
            proxyMcpCommand(["custom-mcp"], {
                AGENTIAM_NODE: "/node",
                AGENTIAM_ENTRYPOINT: "/entry.js",
            }),
        ).toEqual([
            "/node",
            "/entry.js",
            "mcp",
            "custom-mcp-server",
            "--",
            "custom-mcp",
        ]);
        expect(() => checkMcpUrl("https://example.com/custom-mcp")).toThrow(
            "cannot proxy",
        );
    });
});
