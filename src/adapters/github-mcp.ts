import { capability, type CanonicalCapability } from "../capability.js";

const actions: Record<string, string> = {
    get_file_contents: "file.read",
    create_or_update_file: "file.write",
    push_files: "file.write",
    list_issues: "issue.list",
    add_issue_comment: "issue.comment",
    list_pull_requests: "pr.list",
    create_pull_request: "pr.create",
    update_pull_request: "pr.edit",
    merge_pull_request: "pr.merge",
};

const readMethods: Record<string, string> = {
    get: "pr.view",
    get_diff: "pr.diff",
    get_status: "pr.status",
    get_files: "pr.view",
    get_commits: "pr.view",
    get_review_comments: "pr.view",
    get_reviews: "pr.view",
    get_comments: "pr.view",
    get_check_runs: "pr.checks",
};

const issueReadMethods = new Set(["get", "get_comments", "get_labels"]);

export function isGithubMcpTool(name: string): boolean {
    return (
        Object.hasOwn(actions, name) ||
        name === "pull_request_read" ||
        name === "issue_read" ||
        name === "issue_write"
    );
}

export function normalizeGithubMcpCall(
    name: string,
    args: Record<string, unknown> = {},
): CanonicalCapability<"github"> | undefined {
    if (!isGithubMcpTool(name)) return undefined;
    const { owner, repo, method } = args;
    if (
        typeof owner !== "string" ||
        !/^[a-zA-Z0-9-]+$/.test(owner) ||
        typeof repo !== "string" ||
        !/^[a-zA-Z0-9_.-]+$/.test(repo) ||
        repo === "." ||
        repo === ".." ||
        args.parent_owner !== undefined ||
        args.parent_repo !== undefined
    ) {
        return undefined;
    }
    let action = actions[name];
    if (name === "pull_request_read") {
        action =
            typeof method === "string" && Object.hasOwn(readMethods, method)
                ? readMethods[method]
                : undefined;
    }
    if (name === "issue_read") {
        action =
            typeof method === "string" && issueReadMethods.has(method)
                ? "issue.view"
                : undefined;
    }
    if (name === "issue_write") {
        action =
            method === "create"
                ? "issue.create"
                : method === "update"
                  ? "issue.edit"
                  : undefined;
    }
    if (!action) return undefined;
    const [group, operation] = action.split(".");
    return {
        ...capability("github", operation!, group),
        constraints: { repository: `${owner}/${repo}`.toLowerCase() },
    };
}
