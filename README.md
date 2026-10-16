# Agent IAM

Agent IAM provides fail-closed, capability-based policy enforcement for AI-agent CLI actions.

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

Agent IAM is an authorization shim, not a complete sandbox. An agent can still perform actions not covered by `git`, `gh`, or `aws`, and a process can bypass the shim by deliberately changing its environment or invoking another tool. MCP and HTTP adapters, quotas, skill scopes, general policy editing, a central control plane, physical sandboxing, and native Windows support are outside this MVP.

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

The Codex tests use a local scripted Responses API server, isolated `HOME` and `CODEX_HOME` directories, and a fake Git executable. They check allowed and denied shell commands, argument forwarding, tool results, and audit records. The OpenCode tests check the plugin bridge against a private server using a scripted command and a native permission reply. Both use temporary configuration without model inference or API credentials; they do not test interactive TUI rendering or approvals in Codex.

The test subprocess uses `danger-full-access` so it does not depend on host sandbox support. Only scripted tool calls are returned by the local server; these tests validate Agent IAM interception, not Codex sandboxing.

## License

MIT. See [LICENSE](LICENSE).
