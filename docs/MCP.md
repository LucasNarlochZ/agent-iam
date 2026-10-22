# GitHub MCP proxy

Agent IAM can authorize supported official GitHub MCP tools using the same GitHub capabilities and repository constraints as its CLI adapter. Both the client and upstream connection use stdio; HTTP transport is not exposed by the CLI.

Configure [policy rules](POLICIES.md) before calling tools: MCP denials do not trigger interactive policy approval.

## Automatic wrapping

Keep your existing MCP server definitions and launch your agent through Agent IAM:

```bash
agentiam run -- codex
agentiam run -- opencode
agentiam run -- claude
```

Agent IAM replaces recognized stdio server commands with its proxy for that run. It recognizes the official `github-mcp-server` executable, including absolute paths, and Docker/Podman commands using the `ghcr.io/github/github-mcp-server` image. Server aliases do not need to be named `github`. Arbitrary shell scripts, alternative implementations, and remote executors are not automatically recognized.

Original configuration files are not edited. Generated overrides and private files belong to the wrapped process and are removed when it exits. Server environment settings and working directories remain in effect. Policy discovery uses the agent's effective project directory, including Codex's `--cd` and OpenCode's active location, rather than a server's custom working directory.

### Codex

Discovery reads effective server definitions through `codex mcp list --json`, then overrides recognized commands and arguments. Existing server options remain in place. It honors `--config` overrides and resolves `--cd`/`-C` for discovery.

Profiles, worktrees, remote sessions, and plugin-provided servers are not supported by automatic discovery. Discovery failure prevents launch rather than falling back to unprotected execution.

### OpenCode

The V2 temporary plugin transforms the effective MCP registry, including servers from global, project, and inline configuration. V1 does not support automatic wrapping and prints a warning.

### Claude Code

Discovery reads user/local JSON definitions and already approved, trusted project `.mcp.json` entries, then writes a private `--mcp-config` overlay. Disabled entries remain disabled; a recognized project server without prior trust and approval prevents launch.

Explicit MCP JSON/files are merged into the overlay; use one `--mcp-config=VALUE` option per input. Environment references remain references in generated commands.

Native MCP allow/deny lists and detected managed configuration prevent automatic wrapping because replacing a command changes its policy identity. Server-managed/MDM environments, custom `--settings`/`--setting-sources`, worktrees, plugins, and connectors are not supported by this discovery path. Do not use it to enforce enterprise policies.

### Unrecognized and hosted servers

Unrecognized servers are left unchanged with a warning and are outside Agent IAM enforcement. Recognized hosted GitHub HTTP servers cannot be proxied yet: Codex/Claude preparation rejects them, and OpenCode disables them for the wrapped process with a warning.

Direct connections, managed configuration, other plugins, and later configuration changes can lie outside this boundary. This is not a universal MCP sandbox.

## Manual proxy configuration

For other clients or commands that cannot be discovered automatically, configure the MCP client explicitly:

```json
{
    "mcpServers": {
        "github": {
            "command": "agentiam",
            "args": ["mcp", "github", "--", "github-mcp-server", "stdio"]
        }
    }
}
```

Install the official `github-mcp-server` separately and supply credentials through your client's environment or secret configuration. The upstream command inherits the proxy's environment and launches directly without a shell. For Docker installations, use `docker` as the upstream command and pass the appropriate `run --rm -i` arguments after `--`.

## Supported tools

Only these official GitHub MCP tools are exposed:

| Tool                                                             | Capability                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| `get_file_contents`                                              | `github.file.read`                                       |
| `create_or_update_file`, `push_files`                            | `github.file.write`                                      |
| `list_issues`                                                    | `github.issue.list`                                      |
| `issue_read`                                                     | `github.issue.view`                                      |
| `issue_write` (`create` / `update`)                              | `github.issue.create` / `github.issue.edit`              |
| `add_issue_comment`                                              | `github.issue.comment`                                   |
| `list_pull_requests`                                             | `github.pr.list`                                         |
| `create_pull_request`                                            | `github.pr.create`                                       |
| `update_pull_request`                                            | `github.pr.edit`                                         |
| `merge_pull_request`                                             | `github.pr.merge`                                        |
| `pull_request_read` (`get_diff`, `get_status`, `get_check_runs`) | `github.pr.diff`, `github.pr.status`, `github.pr.checks` |
| `pull_request_read` (other supported reads)                      | `github.pr.view`                                         |

Supported `issue_read` methods are `get`, `get_comments`, and `get_labels`. Dedicated parent/sub-issue reads are denied because they can retrieve content from another repository.

Other supported `pull_request_read` methods are `get`, `get_files`, `get_commits`, `get_review_comments`, `get_reviews`, and `get_comments`. Unknown methods, including future upstream additions, are denied. Explicit `parent_owner` or `parent_repo` arguments and cross-repository parent issue operations are not supported.

## Repository policy

Every supported call requires `owner` and `repo`. These become the same repository constraint used by GitHub CLI policies, so existing PR rules apply to both interfaces. Repository comparisons are case-insensitive.

```yaml
allow:
    github.file.read:
        repos: [my-org/my-repo]
    github.issue.view:
        repos: [my-org/my-repo]
    github.pr.view:
        repos: [my-org/my-repo]
deny:
    github.pr.merge: true
```

Policy is reloaded for every call. Directory restrictions use the proxy's working directory, not a path supplied by the caller. Calls without a matching allow, unsupported tools or arguments, invalid policies, and audit failures are denied without interactive approval. Denials return an MCP tool error and never invoke the upstream tool.

Tool discovery is not filtered by current policy. Resources, prompts, and upstream-initiated requests are not proxied. Authorization is audited before forwarding; failed upstream calls are not retried. See [architecture](ARCHITECTURE.md#mcp-authorization-flow) for execution and audit semantics.

Use a trusted official upstream server. Its startup is not policy-gated, and direct access to GitHub or another MCP server bypasses this boundary.
