import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const servers = JSON.parse(
    await readFile(process.env.AGENTIAM_TEST_SERVERS, "utf8"),
);
for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--config") continue;
    const override = args[++index];
    const equal = override.indexOf("=");
    const [root, name, field, key] = override.slice(0, equal).split(".");
    if (root !== "mcp_servers") continue;
    const server = servers.find((item) => item.name === name);
    if (!server) continue;
    const value = JSON.parse(override.slice(equal + 1));
    if (field === "env") server.transport.env[key] = value;
    else if (field === "required") server.required = value;
    else server.transport[field] = value;
}
if (args.includes("list")) {
    process.stdout.write(JSON.stringify(servers));
} else {
    const server = servers[0];
    const client = new Client({ name: "fixture-harness", version: "1.0.0" });
    try {
        await client.connect(
            new StdioClientTransport({
                command: server.transport.command,
                args: server.transport.args,
                env: { ...process.env, ...server.transport.env },
                stderr: "pipe",
            }),
        );
        const allowed = await client.callTool({
            name: "get_file_contents",
            arguments: { owner: "acme", repo: "backend" },
        });
        const denied = await client.callTool({
            name: "merge_pull_request",
            arguments: { owner: "acme", repo: "backend" },
        });
        await writeFile(
            process.env.AGENTIAM_TEST_RESULT,
            JSON.stringify({
                allowed,
                denied,
                server,
                auditDirectory: process.env.AGENTIAM_AUDIT_DIRECTORY,
            }),
        );
    } finally {
        await client.close();
    }
}
