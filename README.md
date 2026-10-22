# Agent IAM

Agent IAM provides fail-closed, capability-based policy enforcement for AI-agent CLI actions and supported GitHub MCP tools.

The central idea is simple: interfaces change, capabilities do not. Whether an agent eventually uses a CLI, MCP, or HTTP adapter, an external action can be normalized into a canonical capability, evaluated by one policy engine, and written to one audit log.

## Why This Repository Exists

Agents increasingly execute actions outside their own process. A command such as `git commit` or `gh pr merge` can change source history, publish work, or affect a remote repository. Agent IAM provides a transparent interception point that makes those actions explicit and policy-controlled without requiring a separate Prolog installation or a syscall sandbox.

## MVP Architecture

```text
Agent process
    |
    v
PATH shims for git, gh, and aws
    |
    v
Canonical capability normalizer
    |
    v
YAML policy -> embedded Tau Prolog
    |
    +--> ALLOW / DENY
    |        |
    |        +--> JSONL audit log
    |
    +--> real binary, only after ALLOW
```

The MVP supports POSIX systems such as Linux and macOS. It uses temporary executable wrappers and does not trace syscalls or provide physical sandboxing.

## Capability Normalization

Agent IAM intercepts `git`, `gh`, and `aws`. A Git subcommand maps to `git.<command>`, a GitHub CLI group and command maps to `github.<group>.<command>`, and an AWS CLI service and operation maps to `aws.<service>.<operation>`.

Examples:

| Command                       | Capability                        |
| ----------------------------- | --------------------------------- |
| `git commit`                  | `git.commit`                      |
| `git remote`                  | `git.remote`                      |
| `git config`                  | `git.config`                      |
| `git symbolic-ref`            | `git.symbolic-ref`                |
| `git push`                    | `git.push`                        |
| `gh pr create`                | `github.pr.create`                |
| `gh pr view`                  | `github.pr.view`                  |
| `gh pr merge`                 | `github.pr.merge`                 |
| `aws sts get-caller-identity` | `aws.sts.get-caller-identity`     |
| `aws s3 cp`                   | `aws.s3.cp`                       |

Unknown command structures are normalized deterministically and denied.

### Supported Git and GitHub CLI commands

Git capabilities use `git.<command>`. Supported commands are:

```text
add am apply archive bisect blame branch bundle checkout cherry-pick clean
clone commit config describe diff fetch grep init log ls-files ls-remote
merge mv pull push rebase reflog remote reset restore revert rev-parse rm
show stash status submodule switch symbolic-ref tag worktree
```

GitHub CLI capabilities use `github.<group>.<command>`:

| Group | Supported commands |
| --- | --- |
| `issue` | close, comment, create, delete, develop, edit, list, lock, pin, reopen, status, transfer, unlock, unpin, view |
| `pr` | checks, checkout, close, comment, create, diff, edit, list, lock, merge, ready, reopen, review, status, unlock, update-branch, view |
| `repo` | archive, clone, create, delete, edit, fork, list, rename, set-default, sync, unarchive, view |
| `run` | cancel, delete, download, list, rerun, view, watch |
| `workflow` | disable, enable, list, run, view |
| `release` | create, delete, delete-asset, download, edit, list, upload, view |
| `auth` | login, logout, refresh, setup-git, status, switch, token |
| `search` | code, commits, issues, prs, repos |
| `gist` | clone, create, delete, edit, list, rename, view |

Registration does not grant permission: unmatched capabilities still require approval in an interactive terminal, and explicit denies still block without prompting. Use `gh issue list`, not `gh issues list`; aliases, extensions, and arbitrary `gh api` calls are not covered by this list.

Git permissions apply to the whole subcommand, including its flags and nested operations (for example, `git branch` includes branch deletion). Only `git.commit` and `git.push` currently support path and branch constraints, respectively. GitHub issue, PR, run, workflow, release, and `repo.view` capabilities support repository constraints. The other repo commands and the auth, search, and gist groups are capability-wide; their positional targets or account-wide effects are not scoped to the current repository.

## Requirements

- Node.js 20 or newer
- A POSIX shell
- `git`, `gh`, and/or `aws` installed when those tools are used

Tau Prolog runs embedded inside the Node.js process. No system Prolog installation is required.

## Installation

Install the scoped package globally or run it directly with npx:

```bash
npm install --global @agentiam-dev/core
npx @agentiam-dev/core inspect
```

The package installs the `agentiam` executable used in the examples below.

For local development:

```bash
npm install
npm run build
node dist/index.js inspect
```

## Policy

Agent IAM reads the global user policy at `~/.agentiam/policy.yaml`. Define allow and deny rules by exact canonical capability:

```yaml
allow:
  aws.sts.get-caller-identity: true
  git.commit: true
  git.remote: true
  git.config: true
  git.symbolic-ref: true
  github.pr.create: true
  github.pr.view: true
deny:
  aws.s3.rm: true
  git.push: true
  github.pr.merge: true
```

An explicit deny always wins over an allow. An unmatched capability is denied. Capability names and constraint names are validated against the supported policy registry; missing or invalid policy files are also denied.

The example policy is available at `examples/policy.yaml`.

Create `~/.agentiam/policy.yaml` from that example:

```bash
agentiam init
```

`init` does not overwrite an existing policy file.

### Directory Policies

Agent IAM also reads `.agentiam/policy.yaml` from the current directory and each parent directory. These policies can only add restrictions to `~/.agentiam/policy.yaml`: their deny rules deny additional matching actions, and their allow rules add required constraints to actions already allowed globally. A directory policy can never allow an action denied or omitted by the global policy.

For example, this project policy prevents merges even when the global policy allows them:

```yaml
deny:
  github.pr.merge: true
```

An invalid directory policy fails closed and denies the action.

### Interactive Approvals

When a supported capability has no matching allow rule, Agent IAM prompts for a policy update. Use the up and down arrow keys to select an option and Enter to confirm. Escape or Ctrl+C selects **Skip**.

```text
[agentiam] github.pr.merge was denied.
❯ Allow this capability
  Allow for repository owner/repo
  Explicitly deny
  Skip
```

The prompt can add an unrestricted allow, add an allow for the current repository, branch, or staged paths, add an explicit deny, or leave the policy unchanged. The selection updates `~/.agentiam/policy.yaml`.

When an intercepted command runs inside an agent, its streams are usually not attached to a TTY. `agentiam run` therefore hosts a local approval broker on a private Unix socket. Generic harnesses present the prompt through the parent process's terminal and pause the agent while the user decides. If neither the command nor the parent runner has a TTY, the action is denied without prompting.

For Codex, Agent IAM registers a temporary local MCP server and sends approval requests through MCP elicitation. Codex displays the choices in its native interface, so Agent IAM does not take over Codex's terminal or pause its TUI. Codex must use an interactive approval policy that permits MCP elicitations; otherwise, the request is skipped and the command remains denied.

Codex's sandboxed shims send approval requests through a private temporary file channel rather than a Unix socket. The parent runner forwards the request to the MCP server outside the sandbox, saves any selected policy change, and returns the choice after saving succeeds. The sandbox therefore needs access to the temporary channel directory, but not write access to `~/.agentiam`. Requests time out after five minutes; an expired request does not save a newly selected policy change. Broker and persistence errors leave the action denied and print the underlying error. Other harnesses retain their existing socket-based approval bridges.

Codex executes shell commands through login shells and controls their environment with `shell_environment_policy`. Agent IAM injects its temporary paths into that policy and uses scoped Zsh, Bash, and POSIX shell startup files to restore the shim directory after user startup files run. The temporary MCP configuration and sockets exist only for the wrapped Codex process.

For OpenCode V1 and V2, run `agentiam run -- opencode`. Agent IAM detects the installed CLI version. V2 uses native permission prompts through a temporary plugin and forces a private server (`--standalone`) so shell commands inherit the wrapped environment. V1 uses the inherited shim environment and the regular terminal approval prompt; it does not load the V2 plugin or add V2-only command-line flags. Both versions reject connections using `--server` or `--attach`. Existing OpenCode configuration stays in place; the V2 plugin is added only for the wrapped process. If `OPENCODE_CONFIG_CONTENT` is set, it must contain a JSON object.

For Claude Code, run `agentiam run -- claude`. Agent IAM adds a temporary MCP server and uses Claude Code's native MCP elicitation question for denied actions; Claude Code's other CLI arguments are passed through unchanged, and existing MCP configuration is retained. The temporary server and socket are removed when Claude Code exits. If native elicitation is unavailable or no user can answer, the action remains denied.

On OpenCode V2, the TUI approval dialog offers **Allow this capability**, **Allow for this context** (when the capability has contextual constraints), **Explicitly deny**, and **Skip**. Allow choices save an Agent IAM policy rule; deny saves a deny rule; skip leaves policy unchanged. Retry the command after saving an allow rule. If the custom TUI dialog is unavailable, OpenCode's native permission prompt remains the fallback and offers its standard approve/reject choices. Approvals are tied to the invoking tool's session, and the OpenCode interface is not paused. Commands outside a tool execution cannot use this approval bridge and remain denied when no policy rule allows them. On V1, approvals use the regular terminal prompt (and require an available TTY). The V2 integration is tested with OpenCode 2.0.29.

An approval only saves the rule; it does not execute the denied command. Retry the command to use the updated policy. Existing explicit denies do not prompt. Unsupported capabilities, invalid policies, and audit failures continue to deny without prompting. AWS approvals are capability-wide because AWS resource constraints are not yet extracted.

## Commands

Initialize the user policy:

```bash
agentiam init
```

Run an agent inside the temporary shim environment:

```bash
agentiam run -- opencode
agentiam run -- claude
agentiam run -- sh -c 'git commit -m "fix"'
```

Inspect the global user policy:

```bash
agentiam inspect
```

Example output from an intercepted session:

```text
[agentiam] ALLOW git.commit
[agentiam] DENY github.pr.merge
```

## GitHub MCP Proxy

Keep your existing MCP server definitions and launch your coding agent through Agent IAM:

```bash
agentiam run -- codex
agentiam run -- opencode
agentiam run -- claude
```

Agent IAM automatically replaces recognized stdio server commands with its proxy for that run. It recognizes the official `github-mcp-server` executable, including absolute paths, and Docker/Podman commands using the `ghcr.io/github/github-mcp-server` image. Server aliases do not need to be named `github`. Arbitrary shell scripts, alternative implementations, and remote executors are not automatically recognized.

The original configuration files are not edited. Generated overrides and private files belong to the wrapped process and are removed when it exits. Server environment settings and working directories remain in effect. Policy discovery uses the agent's effective project directory, including Codex's `--cd` and OpenCode's active location, rather than a server's custom working directory.

- **Codex:** reads effective server definitions through `codex mcp list --json`, then overrides recognized commands and arguments. Existing server options remain in place. Discovery honors `--config` overrides and resolves `--cd`/`-C` for discovery. Profiles, worktrees, remote sessions, and plugin-provided servers are not supported by automatic discovery. Discovery failure prevents launch rather than falling back to unprotected execution.
- **OpenCode V2:** the temporary plugin transforms the effective MCP registry, including servers from global, project, and inline configuration. OpenCode V1 does not support automatic wrapping and prints a warning.
- **Claude Code:** reads user/local JSON definitions and already approved, trusted project `.mcp.json` entries, then writes a private `--mcp-config` overlay. Disabled entries remain disabled; a recognized project server without prior trust and approval prevents launch. Explicit MCP JSON/files are merged into the overlay; use one `--mcp-config=VALUE` option per input. Environment references remain references in generated commands. Native MCP allow/deny lists and detected managed configuration prevent automatic wrapping because replacing a command changes its policy identity. Server-managed/MDM environments, custom `--settings`/`--setting-sources`, worktrees, plugins, and connectors are not supported by this discovery path; do not use it to enforce enterprise policies.

Unrecognized servers are left unchanged with a warning and are outside Agent IAM enforcement. Recognized hosted GitHub HTTP servers cannot be proxied yet: Codex/Claude preparation rejects them, and OpenCode disables them for the wrapped process with a warning. Direct connections, managed configuration, other plugins, and later configuration changes can lie outside this interception boundary; this is not a universal MCP sandbox.

### Manual Proxy Configuration

For other clients, or commands that cannot be discovered automatically, configure the MCP client to launch Agent IAM explicitly:

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

Install the official `github-mcp-server` separately and supply its credentials through your MCP client's environment or secret configuration. The upstream command inherits the proxy's environment. Agent IAM launches it directly without a shell. For Docker-based installations, use `docker` as the upstream command and pass the appropriate `run --rm -i` arguments after `--`.

The client and upstream both use stdio. Policy enforcement is separate from transport construction, allowing a future HTTP upstream without duplicating authorization logic. HTTP transport is not exposed by this CLI yet.

Only these official GitHub MCP tools are exposed:

| Tool | Capability |
| --- | --- |
| `get_file_contents` | `github.file.read` |
| `create_or_update_file`, `push_files` | `github.file.write` |
| `list_issues` | `github.issue.list` |
| `issue_read` | `github.issue.view` |
| `issue_write` (`create` / `update`) | `github.issue.create` / `github.issue.edit` |
| `add_issue_comment` | `github.issue.comment` |
| `list_pull_requests` | `github.pr.list` |
| `create_pull_request` | `github.pr.create` |
| `update_pull_request` | `github.pr.edit` |
| `merge_pull_request` | `github.pr.merge` |
| `pull_request_read` (`get_diff`, `get_status`, `get_check_runs`) | `github.pr.diff`, `github.pr.status`, `github.pr.checks` |
| `pull_request_read` (other supported reads) | `github.pr.view` |

Supported `issue_read` methods are `get`, `get_comments`, and `get_labels`. Dedicated parent/sub-issue reads are denied because they can retrieve content from another repository. Other supported `pull_request_read` methods are `get`, `get_files`, `get_commits`, `get_review_comments`, `get_reviews`, and `get_comments`. Unknown methods are denied, including future methods added by the upstream server. Explicit `parent_owner` or `parent_repo` arguments are not supported; cross-repository parent issue operations are denied.

Every supported call requires `owner` and `repo`. These become the same repository constraint used by GitHub CLI policies, so existing PR rules apply to both interfaces. GitHub repository constraints are compared case-insensitively in both interfaces:

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

Policies are reloaded for every call. Directory restrictions use the proxy's working directory, not a path supplied by the caller. Calls without a matching allow, unsupported tools or arguments, invalid policies, and audit failures are denied without interactive approval. Denials return an MCP tool error and never invoke the upstream tool. Tool discovery is not filtered by current policy; clients can discover supported tools before rules change. Resources, prompts, and upstream-initiated requests are not proxied.

Authorization attempts use the existing JSONL audit log with `tool: "github-mcp"`. To avoid recording credentials or private content, only the supported tool name and normalized repository capability are recorded, not raw MCP arguments, upstream command arguments, or tool results. Upstream stderr is suppressed and transport exceptions return generic errors. Successful authorization is audited before forwarding; it does not prove that GitHub completed the operation. Failed upstream calls are not retried, since a failed response may follow a completed mutation. The upstream process is closed when the client disconnects or the proxy receives SIGINT/SIGTERM.

Use a trusted official upstream server. The proxy is not a sandbox: process startup is not policy-gated, and direct access to GitHub or another MCP server bypasses this boundary.

## Audit Log

Every authorization attempt is appended to `~/.agentiam/audit.jsonl`. If the audit entry cannot be written, the command is denied and the real binary is not executed.

When launched through `agentiam run`, shims send audit records to the parent runner through a private file-based channel in its temporary directory. The parent writes the audit log using its own environment and acknowledges the write before the shim can execute an allowed command. Codex receives the channel path through its shell environment configuration. This lets sandboxed commands log without write access to `~/.agentiam` or Unix-socket connections.

The sandbox must permit reading and writing the temporary channel directory; a sandbox that blocks that directory still denies the command. Agent IAM does not broaden sandbox permissions. A missing acknowledgement after five seconds or an audit-write error denies execution, with the underlying error printed to stderr. An acknowledgement failure can leave a recorded attempt even though execution was denied. The channel is removed when the wrapped process exits. Direct shim invocations without a parent channel write the audit log themselves.

Each line is a JSON object containing the timestamp, structured capability, decision, tool, original argument array, display command, policy path, and decision reason:

```json
{
    "timestamp": "2026-08-15T12:00:00.000Z",
    "capability": {
        "service": "git",
        "action": "commit",
        "canonical": "git.commit"
    },
    "decision": "ALLOW",
    "tool": "git",
    "arguments": ["commit", "-m", "fix"],
    "command": "git commit -m fix",
    "policyPath": "/home/user/.agentiam/policy.yaml",
    "reason": "matched allow rule"
}
```

## Security Properties and Boundaries

- Unknown capabilities are denied by default.
- Explicit deny rules have precedence over allow rules.
- Invalid policy and policy-engine failures deny execution.
- Audit failures deny execution.
- Real binaries are resolved only from the original `PATH`, preventing wrapper recursion.
- Arguments are passed as an array and are not reconstructed through a shell.

Agent IAM is an authorization shim, not a complete sandbox. An agent can still perform actions outside the CLI shims and configured GitHub MCP proxy, and a process can bypass interception by deliberately changing its environment or invoking another tool. Other MCP adapters, HTTP transport and adapters, quotas, skill scopes, general policy editing, a central control plane, physical sandboxing, and native Windows support are outside this MVP.

## Development

```bash
npm install
npm run format:check
npm run typecheck
npm test
npm run build
```

Tool integrations are registered in `src/tools.ts`. Adding a command-only integration requires an adapter class and one registry entry; shim creation, CLI validation, auditing, and policy capability validation derive their tool metadata from that registry. Integrations with policy constraints also define their constraint extraction in the same entry.

The remaining source is organized around policy compilation/evaluation, auditing, interception, and process launching. Tests use temporary homes and fake binaries so they do not modify a developer's real Agent IAM configuration.

### Fast Local Tests

`npm test` builds Agent IAM locally and runs the unit and integration tests, excluding the real Codex and OpenCode suites. It uses installed project dependencies and requires no Docker daemon or installed coding harnesses. Test filters are forwarded to Vitest:

```bash
npm test
npm test -- tests/unit/policy.test.ts
```

`npm run test:watch` runs Vitest directly on the host using your local setup. It includes real-harness suites when their CLIs are available; build Agent IAM first when testing changes exercised through `dist/index.js`.

### Isolated Tests

`npm run test:isolated` builds a Docker image and runs the complete suite, including real CLI integration tests, in a disposable container. It requires a running Docker daemon. Your local OpenCode, Codex, dependencies, build output, credentials, and configuration are not used. Test filters are forwarded to Vitest:

```bash
npm run test:isolated
npm run test:isolated -- tests/integration/real-opencode.test.ts
npm run test:isolated -- tests/integration/real-codex-tui.test.ts
```

The image pins Node.js 24.21.0 by digest, installs Zsh from a dated Debian package snapshot, and installs project dependencies with `npm ci`. Codex 0.162.1 and OpenCode 2.0.29 are pinned in `tests/harnesses/package.json`, with their transitive dependencies locked in its adjacent lockfile. Keep those versions consistent with `tests/harness-versions.json` when updating the harnesses; the image build checks this.

Image provisioning requires registry and Debian snapshot access. Docker caches the installation layers for subsequent runs. The test container has external networking disabled; its loopback interface remains available for scripted local servers. No host directories are mounted, and the container is removed after execution. CI runs the same command.

### Local CLI Compatibility Tests

Use the installed CLIs from your local `PATH` to check compatibility with your setup:

```bash
npm run test:real:codex
npm run test:real:opencode
npm run test:real
```

These commands build Agent IAM and run the selected real CLI suites without installing or replacing your tools. They require local project dependencies, a POSIX environment, and the selected CLIs on `PATH`; missing tools cause an error. Installed versions are printed before testing. Incompatible local versions can fail these tests: the OpenCode native-plugin fixture requires V2.

The Codex tests use a local scripted Responses API server, isolated `HOME` and `CODEX_HOME` directories, and fake Git or AWS executables. They check allowed and denied shell commands, argument forwarding, tool results, and audit records. The OpenCode tests check the plugin bridge against a private server using a scripted command and a native permission reply. Both use temporary configuration without model inference or API credentials.

On Linux, the Codex suite also launches `agentiam run -- codex` in a pseudo-terminal and answers its real native approval dialog with keyboard input. It covers allow, allow once, explicit deny, skip, Escape cancellation, and unavailable elicitation with approval policy `never`. Assertions check policy persistence, initial command execution, a subsequent retry, and audit records. These tests run in `test:isolated` and `test:real:codex`, but not `npm test`; the TUI cases are skipped outside Linux. Local TUI runs require util-linux `/usr/bin/script` and `stty`, already present in the isolated image.

The terminal driver uses fixed dimensions, answers terminal capability queries, and waits for matching output to settle for 100 milliseconds before sending a key. Codex drains queued input when opening security-sensitive dialogs, so sending a key as soon as its label appears can discard the answer. Timeouts include a terminal transcript for diagnosis. These are behavioral dialog tests, not visual snapshot tests.

The test subprocess uses `danger-full-access` so it does not depend on host sandbox support. Only scripted tool calls are returned by the local server; these tests validate Agent IAM interception, not Codex sandboxing.

## License

MIT. See [LICENSE](LICENSE).
