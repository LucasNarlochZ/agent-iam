# Agent IAM

Give your coding agents permission to do useful work without giving them permission to do everything your credentials allow.

Agent IAM checks intercepted Git, GitHub CLI, AWS CLI, and supported GitHub MCP actions against your policy. It denies actions by default and records authorization attempts. Allow routine work, deny sensitive operations, and approve new capabilities as you need them.

## The problem: access is broader than the task

You ask an agent to investigate a GitHub issue, fix the code, and prepare a pull request. It needs to read issues, commit changes locally, and create a PR—but you still want to review before merging.

The credentials available to the agent may also let it merge PRs or delete repositories. An instruction such as “don't merge” expresses your intent; Agent IAM checks intercepted actions against an explicit policy before they execute.

For that workflow, you can allow issue reads, local commits, and PR creation while denying merges and repository deletion. The merge restriction should apply whether the agent uses `gh pr merge` or the equivalent GitHub MCP tool, without maintaining separate rules for each interface.

## One capability, multiple interfaces

Write policy for **what the agent can do**, not each command or protocol it might use. Agent IAM normalizes supported CLI commands and MCP tool calls into the same policy capability:

| Action | GitHub CLI | GitHub MCP tool | Policy capability |
| --- | --- | --- | --- |
| Read an issue | `gh issue view 42 --repo acme/app` | `issue_read` with `method: "get"`, `owner: "acme"`, `repo: "app"`, `issue_number: 42` | `github.issue.view` |
| Create a PR | `gh pr create --repo acme/app …` | `create_pull_request` | `github.pr.create` |
| Merge a PR | `gh pr merge 123 --repo acme/app` | `merge_pull_request` | `github.pr.merge` |

For example, this policy allows issue reads and PR creation in `acme/app`, permits local commits, and denies merges and repository deletion:

```yaml
allow:
  github.issue.view:
    repos: [acme/app]
  github.pr.create:
    repos: [acme/app]
  git.commit: true
deny:
  github.pr.merge: true
  github.repo.delete: true
```

The `github.issue.view` and `github.pr.create` rules apply to both supported GitHub interfaces, including the same repository restriction. The `github.pr.merge` deny blocks both intercepted merge paths. Other actions need their own allow rules; this is a focused policy example, not a complete development policy.

CLI actions must pass through Agent IAM's wrappers, and MCP calls must pass through its [GitHub MCP proxy](docs/MCP.md). MCP support currently covers selected official GitHub tools over stdio—not arbitrary MCP servers or HTTP connections. See [security limits](#security-limits) for bypasses and boundaries.

## Install

Requires Node.js 20 or newer and a POSIX shell on Linux or macOS. Install the tools you want to use (`git`, `gh`, or `aws`) separately.

```bash
npm install --global @agentiam-dev/core
```

You can also run it without a global installation:

```bash
npx @agentiam-dev/core --version
```

## Quick start

Create your policy from the included example:

```bash
agentiam init
```

Review `~/.agentiam/policy.yaml` before using it. The example allows some common commands and explicitly denies operations such as Git pushes and PR merges. `init` never overwrites an existing policy.

Launch your coding agent through Agent IAM:

```bash
agentiam run -- codex
# Or:
agentiam run -- opencode
agentiam run -- claude
```

You can also wrap a single command:

```bash
agentiam run -- gh issue list
```

For supported CLI actions with no matching allow rule, Agent IAM can ask for approval in your terminal or agent interface. Saving an allow rule requires retrying the command; explicit denies never prompt. See [approvals](docs/POLICIES.md#interactive-approvals) for details.

## Your policy, your permissions

Edit `~/.agentiam/policy.yaml` to choose what is allowed:

```yaml
allow:
  git.add: true
  git.commit: true
  github.issue.list: true
deny:
  git.push: true
  github.pr.merge: true
```

Explicit denies take precedence. Project policies can add restrictions, and supported rules can be scoped by repository, branch, or staged paths.

```bash
agentiam inspect policy
```

See the [policy guide](docs/POLICIES.md) and [supported commands](docs/CAPABILITIES.md) for available rules and their limits.

## Understand decisions

See why actions were allowed or denied, including the policy responsible:

```bash
agentiam inspect logs
agentiam inspect logs --tail 10
agentiam inspect logs --head 5 --json
```

See [audit logs](docs/OBSERVABILITY.md) for output formats and approval events.

## Documentation

- [Policies and approvals](docs/POLICIES.md): configure permissions and troubleshoot denied commands.
- [Supported commands](docs/CAPABILITIES.md): Git, GitHub CLI, and AWS capabilities.
- [Coding agent integrations](docs/INTEGRATIONS.md): Codex, OpenCode, and Claude Code setup and compatibility.
- [GitHub MCP](docs/MCP.md): automatic wrapping, manual proxy setup, and supported tools.
- [Audit logs](docs/OBSERVABILITY.md): inspect authorization reasons and approval outcomes.
- [Architecture](docs/ARCHITECTURE.md): enforcement flow, audit logging, and security boundaries.
- [Development](docs/DEVELOPMENT.md): build, test, and extend Agent IAM.
- [Changelog](CHANGELOG.md): release history.

## Security limits

Agent IAM is an authorization layer, **not a sandbox**. It only checks actions that pass through its CLI wrappers or configured GitHub MCP proxy. Direct binary paths, other tools, and direct service connections can bypass interception. Unsupported MCP servers are outside its enforcement boundary.

Read the [security boundaries](docs/ARCHITECTURE.md#goals-and-boundaries) before relying on it to restrict an agent.

## Contributing

See the [development guide](docs/DEVELOPMENT.md) for local setup, testing, and adding integrations.

## License

[MIT](LICENSE).
