import { describe, expect, it } from "vitest";
import {
    GithubMcpAdapter,
    matchesGithubMcpCommand,
    matchesGithubMcpUrl,
} from "../../src/adapters/github-mcp.js";
import {
    capabilityDefinitionFor,
    isMcpAuditToolName,
    isMcpToolName,
    registry,
} from "../../src/registry/builtins.js";

const adapter = new GithubMcpAdapter();
const mappings = [
    ["get_file_contents", undefined, "file.read"],
    ["create_or_update_file", undefined, "file.write"],
    ["push_files", undefined, "file.write"],
    ["list_issues", undefined, "issue.list"],
    ["add_issue_comment", undefined, "issue.comment"],
    ["list_pull_requests", undefined, "pr.list"],
    ["create_pull_request", undefined, "pr.create"],
    ["update_pull_request", undefined, "pr.edit"],
    ["merge_pull_request", undefined, "pr.merge"],
    ["pull_request_read", "get", "pr.view"],
    ["pull_request_read", "get_diff", "pr.diff"],
    ["pull_request_read", "get_status", "pr.status"],
    ["pull_request_read", "get_files", "pr.view"],
    ["pull_request_read", "get_commits", "pr.view"],
    ["pull_request_read", "get_review_comments", "pr.view"],
    ["pull_request_read", "get_reviews", "pr.view"],
    ["pull_request_read", "get_comments", "pr.view"],
    ["pull_request_read", "get_check_runs", "pr.checks"],
    ["issue_read", "get", "issue.view"],
    ["issue_read", "get_comments", "issue.view"],
    ["issue_read", "get_labels", "issue.view"],
    ["issue_write", "create", "issue.create"],
    ["issue_write", "update", "issue.edit"],
] as const;

describe("GitHub MCP normalization", () => {
    it.each(mappings)(
        "normalizes %s with method %s to %s",
        (name, method, action) => {
            expect(adapter.supportsTool(name)).toBe(true);
            const normalized = adapter.normalize({
                name,
                arguments: {
                    owner: "Example-Org",
                    repo: "My_Repo.git",
                    method,
                },
            });
            expect(normalized).toEqual({
                service: "github",
                action: action.split(".")[1],
                canonical: `github.${action}`,
                constraints: { repository: "example-org/my_repo.git" },
            });
            expect(capabilityDefinitionFor(normalized!.canonical)).toEqual({
                constraints: ["repos"],
            });
            expect(
                registry
                    .getMcp("github")
                    .service.policyConstraints(normalized!),
            ).toEqual([
                {
                    name: "repos",
                    values: ["example-org/my_repo.git"],
                    label: "repository example-org/my_repo.git",
                },
            ]);
        },
    );

    it.each([
        "",
        "unknown",
        "delete_repository",
        "get_issue",
        "toString",
        "constructor",
        "__proto__",
    ])("rejects unsupported tool %j", (name) => {
        expect(adapter.supportsTool(name)).toBe(false);
        expect(
            adapter.normalize({
                name,
                arguments: { owner: "org", repo: "repo" },
            }),
        ).toBeUndefined();
    });

    const invalidArguments: Record<string, unknown>[] = [
        { owner: undefined },
        { owner: null },
        { owner: 42 },
        { owner: true },
        { owner: [] },
        { owner: {} },
        { owner: "" },
        { owner: "org/name" },
        { owner: "org_name" },
        { owner: "org.name" },
        { owner: " org" },
        { owner: "org\n" },
        { owner: "örg" },
        { repo: undefined },
        { repo: null },
        { repo: 42 },
        { repo: false },
        { repo: [] },
        { repo: {} },
        { repo: "" },
        { repo: "." },
        { repo: ".." },
        { repo: "org/repo" },
        { repo: "../repo" },
        { repo: "repo name" },
        { repo: "repo\n" },
        { repo: "répo" },
        { repo: "repo\\other" },
        { parent_owner: "org" },
        { parent_owner: null },
        { parent_owner: "" },
        { parent_owner: false },
        { parent_repo: "repo" },
        { parent_repo: null },
        { parent_repo: "" },
        { parent_repo: false },
    ];

    it.each(invalidArguments)("rejects invalid scope %j", (invalid) => {
        expect(
            adapter.normalize({
                name: "get_file_contents",
                arguments: { owner: "org", repo: "repo", ...invalid },
            }),
        ).toBeUndefined();
    });

    describe.each(mappings)(
        "%s method %s argument validation",
        (name, method) => {
            it.each([
                { owner: "../org" },
                { repo: "../repo" },
                { parent_repo: "other" },
            ])("rejects invalid scope %j", (invalid) => {
                expect(
                    adapter.normalize({
                        name,
                        arguments: {
                            owner: "org",
                            repo: "repo",
                            method,
                            ...invalid,
                        },
                    }),
                ).toBeUndefined();
            });

            it("rejects omitted arguments", () => {
                expect(adapter.normalize({ name })).toBeUndefined();
            });
        },
    );

    describe.each(["pull_request_read", "issue_read", "issue_write"])(
        "%s methods",
        (name) => {
            it.each([
                undefined,
                null,
                1,
                true,
                [],
                {},
                "",
                "unknown",
                "GET",
                "delete",
                "toString",
                "constructor",
                "__proto__",
            ])("rejects method %j", (method) => {
                expect(
                    adapter.normalize({
                        name,
                        arguments: { owner: "org", repo: "repo", method },
                    }),
                ).toBeUndefined();
            });
        },
    );

    it.each([
        ["pull_request_read", "create"],
        ["issue_read", "get_diff"],
        ["issue_write", "get"],
    ])("rejects method %s/%s from another operation", (name, method) => {
        expect(
            adapter.normalize({
                name,
                arguments: { owner: "org", repo: "repo", method },
            }),
        ).toBeUndefined();
    });

    it("allows explicitly undefined parent scopes and does not mutate arguments", () => {
        const args = Object.freeze({
            owner: "ORG",
            repo: "REPO",
            parent_owner: undefined,
            parent_repo: undefined,
            path: "src/index.ts",
        });
        expect(
            adapter.normalize({ name: "get_file_contents", arguments: args }),
        ).toMatchObject({ constraints: { repository: "org/repo" } });
        expect(args.owner).toBe("ORG");
        expect(args.repo).toBe("REPO");
    });
});

describe("GitHub MCP command recognition", () => {
    it.each([
        ["github-mcp-server"],
        ["/usr/local/bin/github-mcp-server", "stdio"],
        ["docker", "run", "--rm", "-i", "ghcr.io/github/github-mcp-server"],
        ["/usr/bin/docker", "run", "ghcr.io/github/github-mcp-server:latest"],
        ["podman", "run", "ghcr.io/github/github-mcp-server:v1.2.3"],
        [
            "/usr/bin/podman",
            "run",
            "ghcr.io/github/github-mcp-server@sha256:abcdef0123456789",
        ],
    ])("recognizes %j", (...command) => {
        expect(matchesGithubMcpCommand(Object.freeze(command))).toBe(true);
    });

    it.each([
        [],
        ["gh", "mcp"],
        ["npx", "github-mcp-server"],
        ["github-mcp-server-fake"],
        ["docker", "pull", "ghcr.io/github/github-mcp-server"],
        ["docker", "run", "github/github-mcp-server"],
        ["docker", "run", "ghcr.io/github/github-mcp-server-evil"],
        ["docker", "run", "evil/ghcr.io/github/github-mcp-server"],
        ["docker", "run", "ghcr.io/github/github-mcp-server:"],
        ["docker", "run", "ghcr.io/github/github-mcp-server:bad tag"],
        ["docker", "run", "ghcr.io/github/github-mcp-server@sha256:xyz"],
        ["other", "run", "ghcr.io/github/github-mcp-server"],
    ])("does not recognize %j", (...command) => {
        expect(matchesGithubMcpCommand(command)).toBe(false);
    });
});

describe("GitHub MCP URL recognition", () => {
    it.each([
        "https://api.githubcopilot.com/mcp/",
        "https://API.GITHUBCOPILOT.COM/mcp",
        "https://api.githubcopilot.com:443/mcp?toolsets=issues",
        "http://api.githubcopilot.com/mcp",
    ])("recognizes %s", (url) => {
        expect(matchesGithubMcpUrl(url)).toBe(true);
    });

    it.each([
        "",
        "not a URL",
        "/mcp",
        "api.githubcopilot.com/mcp",
        "https://github.com/mcp",
        "https://api.githubcopilot.com.evil.example/mcp",
        "https://evil.api.githubcopilot.com/mcp",
        "https://api.githubcopilot.com@evil.example/mcp",
        "https://example.com/api.githubcopilot.com",
    ])("rejects %s", (url) => {
        expect(matchesGithubMcpUrl(url)).toBe(false);
    });
});

describe("GitHub MCP registry", () => {
    it("registers the adapter and transport recognizers", () => {
        expect(registry.getMcp("github").adapter).toBeInstanceOf(
            GithubMcpAdapter,
        );
        expect(registry.getMcp("github").service.service).toBe("github");
        expect(registry.getMcp("github").matchesCommand).toBe(
            matchesGithubMcpCommand,
        );
        expect(registry.getMcp("github").matchesUrl).toBe(matchesGithubMcpUrl);
        expect(isMcpToolName("github")).toBe(true);
        expect(isMcpAuditToolName("github-mcp")).toBe(true);
    });

    it.each([
        undefined,
        "",
        "gh",
        "github-mcp",
        "Github",
        "constructor",
        "toString",
        "__proto__",
    ])("rejects registry name %j", (name) => {
        expect(isMcpToolName(name)).toBe(false);
    });

    it.each([
        "",
        "github",
        "gh-mcp",
        "Github-mcp",
        "github-mcp-extra",
        "constructor",
        "__proto__",
    ])("rejects audit name %j", (name) => {
        expect(isMcpAuditToolName(name)).toBe(false);
    });
});
