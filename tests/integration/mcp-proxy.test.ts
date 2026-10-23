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
import {
    ElicitRequestSchema,
    type ElicitRequest,
    type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithShims } from "../../src/runtime/runner.js";

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
    elicit?: (request: ElicitRequest) => Promise<ElicitResult>,
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
    const client = new Client(
        { name: "proxy-test", version: "1.0.0" },
        { capabilities: elicit ? { elicitation: { form: {} } } : {} },
    );
    if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
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
    it("saves a global allow for all repositories without executing until retry", async () => {
        const choices = ["allow", "all"];
        const fixture = await setup("allow: {}\n", {}, async () => ({
            action: "accept",
            content: { choice: choices.shift()! },
        }));
        await fixture.connect();
        const request = {
            name: "get_file_contents",
            arguments: { owner: "acme", repo: "backend" },
        };
        const initial = await fixture.client.callTool(request);
        expect(initial).toMatchObject({ isError: true });
        expect(JSON.stringify(initial)).toContain("retry required");
        expect(await fixture.calls()).toEqual([]);
        expect(
            await readFile(
                join(fixture.home, ".agentiam", "policy.yaml"),
                "utf8",
            ),
        ).toContain("github.file.read: true");
        expect(
            await fixture.client.callTool({
                ...request,
                arguments: { owner: "acme", repo: "other" },
            }),
        ).toMatchObject({ content: [{ text: "upstream-result" }] });
        expect(choices).toEqual([]);
    });

    it("does not retry an upstream failure after an allow-once approval", async () => {
        const fixture = await setup(
            "allow: {}\n",
            { AGENTIAM_TEST_CALL_FAILURE: "1" },
            async () => ({
                action: "accept",
                content: { choice: "allow-once" },
            }),
        );
        await fixture.connect();
        expect(
            await fixture.client.callTool({
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            }),
        ).toMatchObject({
            isError: true,
            content: [{ text: "MCP upstream call failed; no retry was made" }],
        });
        expect(await fixture.calls()).toHaveLength(1);
    });

    it("denies without forwarding when policy becomes invalid during approval", async () => {
        const fixture = await setup("allow: {}\n", {}, async () => {
            await writeFile(
                join(fixture.home, ".agentiam", "policy.yaml"),
                "allow: [invalid",
            );
            return { action: "accept", content: { choice: "allow" } };
        });
        await fixture.connect();
        expect(
            await fixture.client.callTool({
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            }),
        ).toMatchObject({ isError: true });
        expect(await fixture.calls()).toEqual([]);
        expect((await fixture.records())[1]).toMatchObject({
            event: "approval",
            decision: "DENY",
            reasonCode: "approval_error",
        });
    });

    it("does not prompt when the initial audit record cannot be written", async () => {
        let prompts = 0;
        const fixture = await setup("allow: {}\n", {}, async () => {
            prompts++;
            return { action: "accept", content: { choice: "allow-once" } };
        });
        await mkdir(fixture.audit);
        await fixture.connect();
        expect(
            await fixture.client.callTool({
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            }),
        ).toMatchObject({ isError: true });
        expect(prompts).toBe(0);
        expect(await fixture.calls()).toEqual([]);
    });

    it("does not execute an approved call if approval auditing fails", async () => {
        const fixture = await setup("allow: {}\n", {}, async () => {
            await rm(fixture.audit);
            await mkdir(fixture.audit);
            return { action: "accept", content: { choice: "allow-once" } };
        });
        await fixture.connect();
        expect(
            await fixture.client.callTool({
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            }),
        ).toMatchObject({ isError: true });
        expect(await fixture.calls()).toEqual([]);
    });

    it("does not override an explicit deny added while an approval is pending", async () => {
        const fixture = await setup("allow: {}\n", {}, async () => {
            await writeFile(
                join(fixture.home, ".agentiam", "policy.yaml"),
                "deny:\n  github.file.read: true\n",
            );
            return { action: "accept", content: { choice: "allow-once" } };
        });
        await fixture.connect();
        expect(
            await fixture.client.callTool({
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            }),
        ).toMatchObject({ isError: true });
        expect(await fixture.calls()).toEqual([]);
        expect((await fixture.records())[1]).toMatchObject({
            event: "approval",
            decision: "DENY",
            reasonCode: "approval_error",
        });
    });

    it.each(["decline", "cancel", "error", "invalid"])(
        "fails closed on %s elicitation responses without changing policy",
        async (action) => {
            const fixture = await setup("allow: {}\n", {}, async () => {
                if (action === "error")
                    throw new Error("private-approval-error");
                if (action === "invalid")
                    return {
                        action: "accept",
                        content: { choice: "invented-choice" },
                    };
                return { action: action as "decline" | "cancel" };
            });
            await fixture.connect();
            const result = await fixture.client.callTool({
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            });
            expect(result).toMatchObject({ isError: true });
            expect(JSON.stringify(result)).not.toContain(
                "private-approval-error",
            );
            expect(await fixture.calls()).toEqual([]);
            expect(
                await readFile(
                    join(fixture.home, ".agentiam", "policy.yaml"),
                    "utf8",
                ),
            ).toBe("allow: {}\n");
        },
    );

    it("does not persist or forward a call cancelled during approval", async () => {
        let answer!: (value: ElicitResult) => void;
        const response = new Promise<ElicitResult>((resolve) => {
            answer = resolve;
        });
        let prompted = false;
        const fixture = await setup("allow: {}\n", {}, async () => {
            prompted = true;
            return response;
        });
        await fixture.connect();
        const controller = new AbortController();
        const result = fixture.client.callTool(
            {
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            },
            undefined,
            { signal: controller.signal },
        );
        const rejected = expect(result).rejects.toThrow();
        await vi.waitFor(() => expect(prompted).toBe(true));
        controller.abort();
        answer({ action: "accept", content: { choice: "allow" } });
        await rejected;
        await vi.waitFor(async () =>
            expect(await fixture.records()).toHaveLength(2),
        );
        expect(await fixture.calls()).toEqual([]);
        expect(
            await readFile(
                join(fixture.home, ".agentiam", "policy.yaml"),
                "utf8",
            ),
        ).toBe("allow: {}\n");
    });

    it("serializes concurrent permanent approvals without losing repository scopes", async () => {
        const choices = ["allow", "repos", "allow", "repos"];
        const fixture = await setup("allow: {}\n", {}, async () => ({
            action: "accept",
            content: { choice: choices.shift()! },
        }));
        await fixture.connect();
        const results = await Promise.all(
            ["backend", "frontend"].map((repo) =>
                fixture.client.callTool({
                    name: "get_file_contents",
                    arguments: { owner: "acme", repo },
                }),
            ),
        );
        expect(results).toEqual([
            expect.objectContaining({ isError: true }),
            expect.objectContaining({ isError: true }),
        ]);
        expect(choices).toEqual([]);
        const policy = await readFile(
            join(fixture.home, ".agentiam", "policy.yaml"),
            "utf8",
        );
        expect(policy).toContain("acme/backend");
        expect(policy).toContain("acme/frontend");
        expect(await fixture.calls()).toEqual([]);
    });

    it("elicits allow once and audits approval before forwarding only that invocation", async () => {
        let prompts = 0;
        const fixture = await setup("allow: {}\n", {}, async () => {
            prompts++;
            return prompts === 1
                ? { action: "accept", content: { choice: "allow-once" } }
                : { action: "cancel" };
        });
        await fixture.connect();
        const request = {
            name: "get_file_contents",
            arguments: { owner: "acme", repo: "backend" },
        };
        expect(await fixture.client.callTool(request)).toMatchObject({
            content: [{ text: "upstream-result" }],
        });
        expect(await fixture.client.callTool(request)).toMatchObject({
            isError: true,
        });
        expect(prompts).toBe(2);
        expect(await fixture.calls()).toEqual([
            expect.objectContaining({ auditedDecision: "ALLOW" }),
        ]);
        expect(
            await readFile(
                join(fixture.home, ".agentiam", "policy.yaml"),
                "utf8",
            ),
        ).toBe("allow: {}\n");
        expect(await fixture.records()).toEqual([
            expect.objectContaining({
                event: "authorization",
                decision: "DENY",
            }),
            expect.objectContaining({
                event: "approval",
                decision: "ALLOW",
                approval: "allow-once",
                reasonCode: "allow_once",
            }),
            expect.objectContaining({
                event: "authorization",
                decision: "DENY",
            }),
            expect.objectContaining({
                event: "approval",
                decision: "DENY",
                approval: "skip",
            }),
        ]);
    });

    it.each(["allow", "deny"] as const)(
        "saves a repository-scoped local %s and requires retry without forwarding",
        async (choice) => {
            const choices = [choice, "repos"];
            const fixture = await setup("allow: {}\n", {}, async () => ({
                action: "accept",
                content: {
                    choice:
                        choices.shift() ??
                        join(fixture.project, ".agentiam", "policy.yaml"),
                },
            }));
            const path = join(fixture.project, ".agentiam", "policy.yaml");
            await mkdir(join(fixture.project, ".agentiam"));
            await writeFile(path, "allow: {}\n");
            await fixture.connect();
            const request = {
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            };
            expect(await fixture.client.callTool(request)).toMatchObject({
                isError: true,
            });
            expect(await fixture.calls()).toEqual([]);
            expect(await readFile(path, "utf8")).toContain("acme/backend");
            expect(await fixture.client.callTool(request)).toMatchObject(
                choice === "allow"
                    ? { content: [{ text: "upstream-result" }] }
                    : { isError: true },
            );
            expect(await fixture.calls()).toHaveLength(
                choice === "allow" ? 1 : 0,
            );
            expect((await fixture.records())[1]).toMatchObject({
                event: "approval",
                approval: `${choice}-context`,
                policyPath: path,
                policyScope: "directory",
                decision: "DENY",
            });
        },
    );

    it.each([
        [
            "deny:\n  github.file.read: true\n",
            {
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            },
        ],
        [
            "allow: [invalid",
            {
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            },
        ],
        [
            "allow: {}\n",
            {
                name: "delete_repository",
                arguments: { owner: "acme", repo: "backend" },
            },
        ],
    ])(
        "never prompts for explicit denies, invalid policy, or unsupported tools (%s)",
        async (policy, request) => {
            let prompts = 0;
            const fixture = await setup(policy, {}, async () => {
                prompts++;
                return { action: "accept", content: { choice: "allow-once" } };
            });
            await fixture.connect();
            expect(await fixture.client.callTool(request)).toMatchObject({
                isError: true,
            });
            expect(prompts).toBe(0);
            expect(await fixture.calls()).toEqual([]);
        },
    );

    it("grants locally scoped permissions missing globally without allowing other repositories", async () => {
        const fixture = await setup("allow: {}\ndeny: {}\n");
        const path = join(fixture.project, ".agentiam", "policy.yaml");
        await mkdir(join(fixture.project, ".agentiam"));
        await writeFile(
            path,
            "allow:\n  github.file.read:\n    repos: [acme/backend]\n",
        );
        await fixture.connect();
        expect(
            await fixture.client.callTool({
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "backend" },
            }),
        ).toMatchObject({
            content: [{ type: "text", text: "upstream-result" }],
        });
        expect(
            await fixture.client.callTool({
                name: "get_file_contents",
                arguments: { owner: "acme", repo: "other" },
            }),
        ).toMatchObject({ isError: true });
        expect(await fixture.calls()).toHaveLength(1);
        expect(await fixture.records()).toEqual([
            expect.objectContaining({
                decision: "ALLOW",
                reasonCode: "allow_rule",
                policyScope: "directory",
                policyPath: path,
            }),
            expect.objectContaining({
                decision: "DENY",
                reasonCode: "constraint_mismatch",
                policyScope: "directory",
                policyPath: path,
            }),
        ]);
    });

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
