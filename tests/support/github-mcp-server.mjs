import { appendFile, readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

if (process.env.AGENTIAM_TEST_STALL === "1") {
    process.stdin.resume();
} else {
    const server = new Server(
        { name: "github-fixture", version: "1.0.0" },
        { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
        if (process.env.AGENTIAM_TEST_DISCOVERY_FAILURE === "1") {
            throw new Error("private-upstream-error");
        }
        return {
            tools: (request.params?.cursor
                ? ["merge_pull_request"]
                : ["get_file_contents", "delete_repository"]
            ).map((name) => ({ name, inputSchema: { type: "object" } })),
            ...(request.params?.cursor ? {} : { nextCursor: "page-two" }),
        };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const audit = await readFile(process.env.AGENTIAM_TEST_AUDIT, "utf8");
        const record = JSON.parse(audit.trim().split("\n").at(-1));
        await appendFile(
            process.env.AGENTIAM_TEST_CALLS,
            `${JSON.stringify({ ...request.params, auditedDecision: record.decision })}\n`,
        );
        if (process.env.AGENTIAM_TEST_CALL_FAILURE === "1") {
            throw new Error("private-upstream-error");
        }
        return { content: [{ type: "text", text: "upstream-result" }] };
    });
    await server.connect(new StdioServerTransport());
}
