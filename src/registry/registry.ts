import type { CanonicalCapability } from "../capability.js";
import type {
    CapabilityDefinition,
    CliTool,
    McpTool,
    ServiceDefinition,
} from "./types.js";

export class ToolRegistry {
    private readonly services = new Map<string, ServiceDefinition>();
    private readonly cliTools = new Map<string, CliTool>();
    private readonly mcpTools = new Map<string, McpTool>();

    registerService(service: ServiceDefinition): void {
        if (this.services.has(service.service)) {
            throw new Error(`Duplicate service: ${service.service}`);
        }
        this.services.set(service.service, service);
    }

    registerCli(name: string, tool: CliTool): void {
        this.cliTools.set(name, tool);
    }

    registerMcp(name: string, tool: McpTool): void {
        this.mcpTools.set(name, tool);
    }

    hasCli(name: string): boolean {
        return this.cliTools.has(name);
    }

    hasMcp(name: string): boolean {
        return this.mcpTools.has(name);
    }

    getCli(name: string): CliTool {
        const tool = this.cliTools.get(name);
        if (!tool) throw new Error(`Unknown CLI tool: ${name}`);
        return tool;
    }

    getMcp(name: string): McpTool {
        const tool = this.mcpTools.get(name);
        if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
        return tool;
    }

    listCli(): [string, CliTool][] {
        return [...this.cliTools];
    }

    listMcp(): [string, McpTool][] {
        return [...this.mcpTools];
    }

    capabilityDefinitionFor(
        canonical: string,
    ): CapabilityDefinition | undefined {
        for (const service of this.services.values()) {
            const definition = service.capabilityDefinition(canonical);
            if (definition) return definition;
        }
        return undefined;
    }

    serviceForCapability(
        capability: CanonicalCapability,
    ): ServiceDefinition | undefined {
        const service = this.services.get(capability.service);
        return service?.capabilityDefinition(capability.canonical) !== undefined
            ? service
            : undefined;
    }
}
