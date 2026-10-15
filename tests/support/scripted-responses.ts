import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

interface ResponseInput {
    type: string;
    call_id?: string;
    output?: unknown;
}

interface ResponsesRequest {
    input: ResponseInput[];
    tools: { type: string; name?: string }[];
}

export async function startScriptedResponses(command: string, cwd: string) {
    const requests: ResponsesRequest[] = [];
    const errors: string[] = [];
    const server = createServer(async (request, response) => {
        try {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
                throw new Error(
                    `Unexpected request: ${request.method} ${request.url}`,
                );
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(
                Buffer.concat(chunks).toString(),
            ) as ResponsesRequest;
            requests.push(body);
            const id = `agentiam-response-${requests.length}`;
            let item: Record<string, unknown>;
            if (requests.length === 1) {
                const tool = ["exec_command", "shell_command", "shell"].find(
                    (name) => body.tools.some((tool) => tool.name === name),
                );
                if (!tool)
                    throw new Error(
                        "Codex did not advertise a supported shell tool",
                    );
                const args =
                    tool === "exec_command"
                        ? { cmd: command, workdir: cwd, yield_time_ms: 10_000 }
                        : tool === "shell_command"
                          ? { command, workdir: cwd, timeout_ms: 10_000 }
                          : {
                                command: ["/bin/bash", "-lc", command],
                                workdir: cwd,
                                timeout_ms: 10_000,
                            };
                item = {
                    id: "agentiam-function-call",
                    type: "function_call",
                    call_id: "agentiam-shell-call",
                    name: tool,
                    arguments: JSON.stringify(args),
                };
            } else if (requests.length === 2) {
                item = {
                    id: "agentiam-final-message",
                    type: "message",
                    role: "assistant",
                    content: [
                        {
                            type: "output_text",
                            text: "Scripted test complete.",
                        },
                    ],
                };
            } else {
                throw new Error("Unexpected additional model request");
            }
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            for (const event of [
                { type: "response.created", response: { id } },
                { type: "response.output_item.done", output_index: 0, item },
                {
                    type: "response.completed",
                    response: {
                        id,
                        status: "completed",
                        output: [item],
                        usage: {
                            input_tokens: 0,
                            output_tokens: 0,
                            total_tokens: 0,
                        },
                    },
                },
            ]) {
                response.write(
                    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                );
            }
            response.end();
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
            response.writeHead(500);
            response.end("Scripted Responses server rejected the request");
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        requests,
        errors,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}
