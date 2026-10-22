import { spawn } from "node:child_process";
import { once } from "node:events";
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { runWithShims } from "../../src/runner.js";

const directories: string[] = [];
const clients: Client[] = [];
const entrypoint = resolve("dist/index.js");
const upstream = resolve("tests/support/github-mcp-server.mjs");

afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(
        directories
            .splice(0)
            .map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function setup(
    policy = "allow:\n  github.file.read:\n    repos: [acme/backend]\n",
    extraEnv: Record<string, string> = {},
) {
    const directory = await mkdtemp(join(tmpdir(), "agentiam-proxy-"));
    directories.push(directory);
    const home = join(directory, "home");
    const project = join(directory, "project");
    const audit = join(home, ".agentiam", "audit.jsonl");
    const calls = join(directory, "calls.jsonl");
    await mkdir(join(home, ".agentiam"), { recursive: true });
    await mkdir(project);
    await writeFile(join(home, ".agentiam", "policy.yaml"), policy);
    await writeFile(calls, "");
    const env = {
        HOME: home,
        PATH: process.env.PATH ?? "",
        AGENTIAM_MCP_POLICY_CWD: project,
        AGENTIAM_TEST_AUDIT: audit,
        AGENTIAM_TEST_CALLS: calls,
        ...extraEnv,
    };
    const client = new Client({ name: "proxy-test", version: "1.0.0" });
    clients.push(client);
    return {
        project,
        home,
        env,
        audit,
        client,
        connect: () =>
            client.connect(
                new StdioClientTransport({
                    command: process.execPath,
                    args: [
                        entrypoint,
                        "mcp",
                        "github",
                        "--",
                        process.execPath,
                        upstream,
                    ],
                    env,
                    stderr: "pipe",
                }),
            ),
        calls: async () =>
            (await readFile(calls, "utf8"))
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line)),
        records: async () =>
            (await readFile(audit, "utf8"))
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line)),
    };
}

describe("built MCP proxy", () => {
    it("automatically wraps a harness server and brokers audit records without changing its definition", async () => {
        const fixture = await setup();
        const bin = join(fixture.project, "bin");
        await mkdir(bin);
        const codex = join(bin, "codex");
        const github = join(bin, "github-mcp-server");
        await writeFile(
            codex,
            `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("tests/support/mcp-harness.mjs"))} "$@"\n`,
        );
        await writeFile(
            github,
            `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(upstream)} "$@"\n`,
        );
        await Promise.all([chmod(codex, 0o755), chmod(github, 0o755)]);
        const configPath = join(fixture.project, "servers.json");
        const resultPath = join(fixture.project, "result.json");
        const original = JSON.stringify([
            {
                name: "octo",
                enabled: true,
                transport: {
                    type: "stdio",
                    command: github,
                    args: ["stdio"],
                    env: { KEEP: "original" },
                },
            },
        ]);
        await writeFile(configPath, original);
        expect(
            await runWithShims(codex, [], {
                cwd: fixture.project,
                entrypoint,
                env: {
                    ...fixture.env,
                    AGENTIAM_TEST_SERVERS: configPath,
                    AGENTIAM_TEST_RESULT: resultPath,
                },
            }),
        ).toEqual({ code: 0, signal: null });
        const result = JSON.parse(await readFile(resultPath, "utf8"));
        expect(result.allowed).toMatchObject({
            content: [{ text: "upstream-result" }],
        });
        expect(result.denied).toMatchObject({ isError: true });
        expect(result.server.transport).toMatchObject({
            command: process.execPath,
            args: [entrypoint, "mcp", "github", "--", github, "stdio"],
            env: { KEEP: "original" },
        });
        expect(await fixture.calls()).toHaveLength(1);
        expect(
            (await fixture.records()).map((record) => record.decision),
        ).toEqual(["ALLOW", "DENY"]);
        expect(await readFile(configPath, "utf8")).toBe(original);
        await expect(access(result.auditDirectory)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("filters unsupported discovery entries and preserves pagination", async () => {
        const fixture = await setup();
        await fixture.connect();
        const first = await fixture.client.listTools();
        expect(first.tools.map((tool) => tool.name)).toEqual([
            "get_file_contents",
        ]);
        expect(first.nextCursor).toBe("page-two");
        const second = await fixture.client.listTools({
            cursor: first.nextCursor,
        });
        expect(second.tools.map((tool) => tool.name)).toEqual([
            "merge_pull_request",
        ]);
        expect(second.nextCursor).toBeUndefined();
        expect(await fixture.calls()).toEqual([]);
    });

    it("audits an allowed call before forwarding its original arguments", async () => {
        const fixture = await setup();
        await fixture.connect();
        const args = {
            owner: "ACME",
            repo: "Backend",
            path: "private-name.txt",
            ref: "main",
        };
        const result = await fixture.client.callTool({
            name: "get_file_contents",
            arguments: args,
        });
        expect(result).toMatchObject({
            content: [{ type: "text", text: "upstream-result" }],
        });
        expect(await fixture.calls()).toEqual([
            {
                name: "get_file_contents",
                arguments: args,
                auditedDecision: "ALLOW",
            },
        ]);
        expect(await fixture.records()).toEqual([
            expect.objectContaining({
                tool: "github-mcp",
                decision: "ALLOW",
                capability: expect.objectContaining({
                    canonical: "github.file.read",
                    constraints: { repository: "acme/backend" },
                }),
                arguments: ["get_file_contents"],
            }),
        ]);
        expect(await readFile(fixture.audit, "utf8")).not.toContain(
            "private-name.txt",
        );
    });

    it.each([
        {
            name: "merge_pull_request",
            arguments: { owner: "acme", repo: "backend" },
        },
        {
            name: "get_file_contents",
            arguments: { owner: "acme", repo: "other" },
        },
        {
            name: "delete_repository",
            arguments: { owner: "acme", repo: "backend" },
        },
        {
            name: "get_file_contents",
            arguments: { owner: "acme", repo: "backend", parent_repo: "other" },
        },
    ])(
        "denies and audits $name without upstream side effects ($arguments)",
        async (request) => {
            const fixture = await setup();
            await fixture.connect();
            expect(await fixture.client.callTool(request)).toMatchObject({
                isError: true,
            });
            expect(await fixture.calls()).toEqual([]);
            expect(await fixture.records()).toEqual([
                expect.objectContaining({ decision: "DENY" }),
            ]);
        },
    );

    it("applies project denials even when the user policy allows the call", async () => {
        const fixture = await setup("allow:\n  github.pr.merge: true\n");
        await mkdir(join(fixture.project, ".agentiam"));
        await writeFile(
            join(fixture.project, ".agentiam", "policy.yaml"),
            "deny:\n  github.pr.merge: true\n",
        );
        await fixture.connect();
        expect(
            await fixture.client.callTool({
                name: "merge_pull_request",
                arguments: { owner: "acme", repo: "backend" },
            }),
        ).toMatchObject({ isError: true });
        expect(await fixture.calls()).toEqual([]);
        expect((await fixture.records())[0]).toMatchObject({
            decision: "DENY",
            reasonCode: "deny_rule",
            policyScope: "directory",
            policyPath: join(fixture.project, ".agentiam", "policy.yaml"),
        });
    });

    it("denies malformed policies without forwarding", async () => {
        const fixture = await setup("allow: [invalid");
        await fixture.connect();
        expect(
            await fixture.client.callTool({
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            }),
        ).toMatchObject({ isError: true });
        expect(await fixture.calls()).toEqual([]);
        expect((await fixture.records())[0]).toMatchObject({
            decision: "DENY",
            reasonCode: "policy_error",
            reason: "policy is invalid; call denied before forwarding",
        });
    });

    it("fails closed when the audit destination cannot be written", async () => {
        const fixture = await setup();
        await mkdir(fixture.audit);
        await fixture.connect();
        expect(
            await fixture.client.callTool({
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            }),
        ).toMatchObject({
            isError: true,
            content: [
                { text: "Agent IAM denied the call: audit log unavailable" },
            ],
        });
        expect(await fixture.calls()).toEqual([]);
    });

    it("fails closed when the configured audit broker is unavailable", async () => {
        const fixture = await setup(undefined, {
            AGENTIAM_AUDIT_DIRECTORY: "/nonexistent/agentiam-test-broker",
        });
        await fixture.connect();
        expect(
            await fixture.client.callTool({
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            }),
        ).toMatchObject({
            isError: true,
            content: [
                { text: "Agent IAM denied the call: audit log unavailable" },
            ],
        });
        expect(await fixture.calls()).toEqual([]);
    });

    it("reloads policy changes between calls in the same session", async () => {
        const fixture = await setup();
        await fixture.connect();
        const request = {
            name: "get_file_contents",
            arguments: { owner: "acme", repo: "backend" },
        };
        expect(await fixture.client.callTool(request)).not.toMatchObject({
            isError: true,
        });
        await writeFile(
            join(fixture.home, ".agentiam", "policy.yaml"),
            "deny:\n  github.file.read: true\n",
        );
        expect(await fixture.client.callTool(request)).toMatchObject({
            isError: true,
        });
        expect(await fixture.calls()).toHaveLength(1);
        expect(
            (await fixture.records()).map((record) => record.decision),
        ).toEqual(["ALLOW", "DENY"]);
    });

    it("sanitizes upstream failures without retrying an authorized call", async () => {
        const fixture = await setup(undefined, {
            AGENTIAM_TEST_CALL_FAILURE: "1",
        });
        await fixture.connect();
        const result = await fixture.client.callTool({
            name: "get_file_contents",
            arguments: { owner: "acme", repo: "backend" },
        });
        expect(result).toMatchObject({
            isError: true,
            content: [{ text: "MCP upstream call failed; no retry was made" }],
        });
        expect(JSON.stringify(result)).not.toContain("private-upstream-error");
        expect(await fixture.calls()).toHaveLength(1);
    });

    it("sanitizes tool discovery failures", async () => {
        const fixture = await setup(undefined, {
            AGENTIAM_TEST_DISCOVERY_FAILURE: "1",
        });
        await fixture.connect();
        await expect(fixture.client.listTools()).rejects.toThrow(
            "MCP tool discovery failed",
        );
        expect(await fixture.calls()).toEqual([]);
    });

    it("shuts down when stdin closes during stalled upstream initialization", async () => {
        const fixture = await setup(undefined, { AGENTIAM_TEST_STALL: "1" });
        const child = spawn(
            process.execPath,
            [entrypoint, "mcp", "github", "--", process.execPath, upstream],
            { env: fixture.env, stdio: ["pipe", "ignore", "pipe"] },
        );
        try {
            const exited = once(child, "exit", {
                signal: AbortSignal.timeout(3000),
            });
            child.stdin.end();
            expect(await exited).toEqual([0, null]);
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
                await once(child, "exit");
            }
        }
    });
});
