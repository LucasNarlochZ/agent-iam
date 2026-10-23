# Architecture

Agent IAM authorizes supported CLI actions and GitHub MCP calls against a shared policy. Interfaces normalize actions into capabilities such as `git.commit` or `github.pr.merge`; the policy engine evaluates those capabilities before execution.

For setup, start with the [README](../README.md). See [policies](POLICIES.md) for rule semantics and [integrations](INTEGRATIONS.md) for agent-specific configuration and compatibility limits.

## Goals and boundaries

Agent IAM provides default-deny authorization, explicit deny precedence, and audit records for intercepted actions. It supports POSIX systems such as Linux and macOS and runs Tau Prolog inside Node.js without a separate Prolog installation.

It is an authorization shim, not a sandbox. A process can bypass interception by changing its environment, invoking an absolute binary path, using another tool, or connecting directly to an external service. Agent IAM does not trace syscalls or broaden an agent's sandbox permissions.

Other MCP adapters, HTTP transport and adapters, quotas, skill scopes, general policy editing, a central control plane, physical sandboxing, and native Windows support are outside the current scope.

## CLI execution flow

```text
Agent or command launched with agentiam run
    |
    v
Temporary PATH wrappers for git, gh, and aws
    |
    v
Adapter normalizes arguments into a capability
    |
    v
YAML policy -> embedded Tau Prolog -> ALLOW / DENY
    |
    v
Audit write acknowledged
    |
    +--> ALLOW: execute the real binary
    |
    +--> DENY: request approval when eligible, otherwise exit 126
```

The runner creates temporary wrappers and private communication channels for the wrapped process. Real binaries are resolved from the original `PATH` to prevent wrapper recursion. Arguments are forwarded as an array, not reconstructed through a shell.

Adapters produce canonical capabilities and any supported context, such as repository, branch, or staged paths. The global user policy and directory policies are loaded before evaluation. A matching explicit deny in any applicable policy takes precedence; otherwise, a matching allow in any policy grants permission. Without a matching allow, the action is denied. Unknown capabilities, invalid policies, policy-engine errors, and audit failures deny execution.

## Approval bridges

For supported capabilities denied because no allow rule matches, the shim can request approval. Explicit denies do not prompt. See [policy approvals](POLICIES.md#interactive-approvals) for the user-facing choices.

Generic harnesses use a private Unix-socket broker in the parent runner. The parent pauses the agent while presenting a terminal prompt and resumes it after the decision. If neither process has an interactive terminal, the action remains denied.

Codex and Claude Code use a temporary MCP server to present native elicitation questions. OpenCode V2 uses a temporary plugin and native permission dialogs. These bridges avoid taking over the agent's terminal; compatibility details are in the [integration guide](INTEGRATIONS.md).

### Sandboxed Codex approvals

Codex shims send approval requests through a private temporary file channel rather than a Unix socket. The parent runner forwards the request to the MCP server outside the sandbox, saves the selected policy change, and returns the choice after saving succeeds. This requires access to the temporary channel directory, not write access to `~/.agentiam`.

Requests time out after five minutes. An expired request does not save a newly selected policy change. Broker and persistence errors leave the action denied and print the underlying error. Other harnesses retain their socket-based approval bridges.

## MCP authorization flow

The GitHub proxy connects the client and official upstream server over stdio. It exposes only supported tools, normalizes each call into a GitHub capability, reloads policy, and records authorization before forwarding an allowed call.

Denied calls return an MCP tool error without invoking the upstream tool. Tool discovery exposes supported tools regardless of current policy; resources, prompts, and upstream-initiated requests are not proxied. Policy enforcement is separate from transport construction, but HTTP transport is not exposed by the CLI.

Successful authorization does not prove that GitHub completed an operation. Failed upstream calls are not retried because a failed response may follow a completed mutation. The upstream process closes when the client disconnects or the proxy receives SIGINT or SIGTERM. Server startup itself is not policy-gated; use a trusted official upstream server.

## Audit log

Authorization attempts and CLI approval outcomes are appended to `~/.agentiam/audit.jsonl`. Use `agentiam inspect logs` to read them; see [audit logs](OBSERVABILITY.md) for options, reason codes, and event semantics. If a required audit entry cannot be written, the real command or upstream tool is not executed.

With `agentiam run`, shims send records to the parent through a private file-based channel. The parent writes the log using its own environment and acknowledges the write before an allowed command can execute. Codex receives the channel path through its shell environment configuration, allowing sandboxed commands to log without write access to `~/.agentiam` or Unix-socket connections.

The sandbox must allow reading and writing the temporary channel directory. A missing acknowledgement after five seconds or an audit-write error denies execution and prints the underlying error. An acknowledgement failure can leave a recorded attempt even though execution was denied. The channel is removed when the wrapped process exits. Direct shim invocations without a parent channel write the log themselves.

CLI records include the timestamp, structured capability, decision, tool, original arguments, display command, decisive policy path, and reason. New records add a request identifier, event type, reason code, and policy scope when available:

```json
{
    "requestId": "b591e952-ccf6-45c5-97fe-e840b22efdb0",
    "event": "authorization",
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
    "policyScope": "global",
    "reasonCode": "allow_rule",
    "reason": "matched global allow rule for git.commit"
}
```

GitHub MCP records use `tool: "github-mcp"`. To avoid recording credentials or private content, they contain the supported tool name and normalized repository capability, not raw MCP arguments, upstream command arguments, or tool results. Upstream stderr is suppressed and transport exceptions return generic errors.

## Source entry points

| Area                          | Entry point                                               |
| ----------------------------- | --------------------------------------------------------- |
| CLI dispatch                  | [`src/cli/cli.ts`](../src/cli/cli.ts)                     |
| Wrapped process lifecycle     | [`src/runtime/runner.ts`](../src/runtime/runner.ts)       |
| CLI authorization             | [`src/runtime/shim.ts`](../src/runtime/shim.ts)           |
| Built-in tool registration    | [`src/registry/builtins.ts`](../src/registry/builtins.ts) |
| Service capabilities          | [`src/services/`](../src/services/)                       |
| Policy loading and evaluation | [`src/policy/`](../src/policy/)                           |
| Agent integrations            | [`src/harnesses/`](../src/harnesses/)                     |
| MCP forwarding                | [`src/mcp/mcp-proxy.ts`](../src/mcp/mcp-proxy.ts)         |

See [development](DEVELOPMENT.md) for extending the registry and running tests.
