import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { requestBrokerApproval } from "../../src/approval-broker.js";
import {
    createMcpApprovalServer,
    startMcpApprovalSocket,
} from "../../src/mcp-approval.js";

describe("MCP approval socket", () => {
    it("forwards shim approval requests to the MCP client", async () => {
        const directory = await mkdtemp(join(tmpdir(), "agentiam-mcp-"));
        const socketPath = join(directory, "approval.sock");
        const client = new Client(
            { name: "test-client", version: "1.0.0" },
            { capabilities: { elicitation: { form: {} } } },
        );
        const server = createMcpApprovalServer();
        client.setRequestHandler(ElicitRequestSchema, async (request) => ({
            action: "accept",
            content: {
                choice: request.params.mode === "form" ? "allow" : "skip",
            },
        }));
        const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
        await Promise.all([
            client.connect(clientTransport),
            server.connect(serverTransport),
        ]);
        await expect(client.listTools()).resolves.toEqual({ tools: [] });
        const socket = await startMcpApprovalSocket(socketPath, server);

        await expect(
            requestBrokerApproval(socketPath, {
                service: "aws",
                action: "s3.ls",
                canonical: "aws.s3.ls",
            }),
        ).resolves.toBe("allow");

        await socket.close();
        await client.close();
        await server.close();
    });
});
