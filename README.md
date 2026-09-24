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
PATH shims for git and gh
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

The first release intercepts `git` and `gh`. A Git subcommand maps to `git.<command>`, while a GitHub CLI group and command map to `github.<group>.<command>`.

Examples:

| Command            | Capability         |
| ------------------ | ------------------ |
| `git commit`       | `git.commit`       |
| `git remote`       | `git.remote`       |
| `git config`       | `git.config`       |
| `git symbolic-ref` | `git.symbolic-ref` |
| `git push`         | `git.push`         |
| `gh pr create`     | `github.pr.create` |
| `gh pr view`       | `github.pr.view`   |
| `gh pr merge`      | `github.pr.merge`  |

Unknown command structures are normalized deterministically and denied unless explicitly allowed.

## Requirements

- Node.js 20 or newer
- A POSIX shell
- `git` and/or `gh` installed when those tools are used

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
  git.commit: true
  git.remote: true
  git.config: true
  git.symbolic-ref: true
  github.pr.create: true
  github.pr.view: true
deny:
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

## Commands

Initialize the user policy:

```bash
agentiam init
```

Run an agent inside the temporary shim environment:

```bash
agentiam run -- opencode
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

Agent IAM is an authorization shim, not a complete sandbox. An agent can still perform actions not covered by `git` or `gh`, and a process can bypass the shim by deliberately changing its environment or invoking another tool. MCP and HTTP adapters, approval prompts, quotas, skill scopes, policy editing, a central control plane, physical sandboxing, and native Windows support are outside this MVP.

## Development

```bash
npm install
npm run format:check
npm run typecheck
npm test
npm run build
```

The source is organized around normalization, policy compilation/evaluation, auditing, interception, and process launching. Tests use temporary homes and fake binaries so they do not modify a developer's real Agent IAM configuration.

## License

MIT. See [LICENSE](LICENSE).
