import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fixture = join(process.env.HOME, "test-plugin");
await mkdir(fixture);
await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({ type: "module", main: "index.js" }),
);
await writeFile(
    join(fixture, "index.js"),
    `export default {
    id: "agentiam-test",
    async setup(ctx) {
        await ctx.command.transform(editor => editor.add({
            name: "agentiam-test",
            async execute({sessionID}) {
                const shell = (await ctx.tool.list()).find(tool => tool.id === "shell");
                const result = await shell.execute({command: "git push origin test", description: "Test Agent IAM"}, {
                    sessionID, agent: "build", messageID: "msg_agentiamtest", id: "call_agentiamtest",
                    signal: new AbortController().signal, progress: async () => {},
                });
                await import("node:fs/promises").then(fs => fs.writeFile(${JSON.stringify(join(process.env.HOME, "result.json"))}, JSON.stringify(result)));
            },
        }));
    },
};`,
);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
config.plugins.push(pathToFileURL(fixture).href);
const server = spawn(
    process.env.AGENTIAM_TEST_OPENCODE,
    ["serve", "--port", "0", "--print-logs", "--log-level", "debug"],
    {
        env: {
            ...process.env,
            OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        },
        stdio: ["ignore", "pipe", "pipe"],
    },
);
let logs = "";
server.stderr.on("data", (data) => {
    logs += data;
});
try {
    let output = "";
    const url = await new Promise((resolve, reject) => {
        server.once("exit", (code) =>
            reject(new Error(`Server exited ${code}: ${logs}`)),
        );
        server.stdout.on("data", (data) => {
            output += data;
            const match = output.match(/server listening on (http:\/\/\S+)/);
            if (match) resolve(match[1]);
        });
    });
    const headers = {
        authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
        "content-type": "application/json",
    };
    async function api(path, body) {
        const response = await fetch(`${url}${path}`, {
            headers,
            method: body === undefined ? "GET" : "POST",
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok)
            throw new Error(`${path}: ${response.status} ${text}`);
        return text ? JSON.parse(text) : undefined;
    }
    const { data: session } = await api("/api/session", {
        title: "Agent IAM test",
    });
    const command = api(`/api/session/${session.id}/command`, {
        name: "agentiam-test",
        text: "",
    }).catch((error) => ({ error }));
    async function waitForApproval() {
        for (let attempt = 0; attempt < 100; attempt++) {
            const result = await api("/api/permission/request");
            const pending = result.data.find(
                (request) => request.action === "agentiam.allow",
            );
            if (pending) return pending;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`No native Agent IAM permission request: ${logs}`);
    }
    const pending = await waitForApproval();
    if (
        pending.sessionID !== session.id ||
        !pending.resources.includes("git.push")
    ) {
        throw new Error(
            "Permission request is not bound to the invoking session and capability",
        );
    }
    const decision = process.env.AGENTIAM_TEST_DECISION;
    await api(`/api/session/${session.id}/permission/${pending.id}/reply`, {
        decision,
    });
    const result = await command;
    if (result?.error) throw result.error;
    const policy = await readFile(
        join(process.env.HOME, ".agentiam/policy.yaml"),
        "utf8",
    );
    if (policy !== "allow: {}\ndeny: {}\n") {
        throw new Error(`Unexpected policy after ${decision}: ${policy}`);
    }
    const first = await readFile(join(process.env.HOME, "result.json"), "utf8");
    if (!first.includes("[agentiam] DENY git.push"))
        throw new Error(`Command was not denied: ${first}`);
    if (decision === "once") {
        if (JSON.parse(first).metadata?.exit !== 0)
            throw new Error(`Allow once did not execute: ${first}`);
        const retryCommand = api(`/api/session/${session.id}/command`, {
            name: "agentiam-test",
            text: "",
        });
        const retryApproval = await waitForApproval();
        await api(
            `/api/session/${session.id}/permission/${retryApproval.id}/reply`,
            {
                decision: "reject",
            },
        );
        await retryCommand;
        const retry = await readFile(
            join(process.env.HOME, "result.json"),
            "utf8",
        );
        if (
            JSON.parse(retry).metadata?.exit !== 126 ||
            !retry.includes("[agentiam] DENY git.push")
        )
            throw new Error(`Retry did not require another approval: ${retry}`);
    }
    console.log(`Native OpenCode approval handled: ${decision}`);
} finally {
    server.kill("SIGTERM");
    await once(server, "close");
}
