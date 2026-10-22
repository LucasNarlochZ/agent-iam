import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

interface MessagesRequest {
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ name: string }>;
    stream?: boolean;
}

export async function startScriptedMessages(command: string) {
    const requests: MessagesRequest[] = [];
    const errors: string[] = [];
    const server = createServer(async (request, response) => {
        try {
            if (
                request.method !== "POST" ||
                !request.url?.startsWith("/v1/messages")
            ) {
                response.writeHead(404).end();
                return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(
                Buffer.concat(chunks).toString(),
            ) as MessagesRequest;
            // Claude also makes auxiliary requests without shell tools.
            const hasBash = body.tools?.some((tool) => tool.name === "Bash");
            if (hasBash) requests.push(body);
            if (requests.length > 2)
                throw new Error(
                    "Unexpected additional model request (possible permission loop)",
                );
            const toolUse = hasBash && requests.length === 1;
            const block = toolUse
                ? {
                      type: "tool_use",
                      id: "toolu_agentiam",
                      name: "Bash",
                      input: { command, description: "Test Agent IAM" },
                  }
                : { type: "text", text: "Scripted test complete." };
            const message = {
                id: `msg_agentiam_${requests.length}`,
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [block],
                stop_reason: toolUse ? "tool_use" : "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 10 },
            };
            if (!body.stream) {
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify(message));
                return;
            }
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            for (const event of [
                {
                    type: "message_start",
                    message: { ...message, content: [], stop_reason: null },
                },
                {
                    type: "content_block_start",
                    index: 0,
                    content_block: toolUse
                        ? { ...block, input: {} }
                        : { type: "text", text: "" },
                },
                {
                    type: "content_block_delta",
                    index: 0,
                    delta: toolUse
                        ? {
                              type: "input_json_delta",
                              partial_json: JSON.stringify(block.input),
                          }
                        : { type: "text_delta", text: block.text },
                },
                { type: "content_block_stop", index: 0 },
                {
                    type: "message_delta",
                    delta: {
                        stop_reason: message.stop_reason,
                        stop_sequence: null,
                    },
                    usage: { output_tokens: 10 },
                },
                { type: "message_stop" },
            ])
                response.write(
                    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                );
            response.end();
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
            if (!response.headersSent) response.writeHead(500);
            response.end("Scripted Messages server rejected the request");
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests,
        errors,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}
