# Agent IAM

[![npm version](https://img.shields.io/npm/v/%40agentiam-dev%2Fcore)](https://www.npmjs.com/package/@agentiam-dev/core)
[![CI](https://github.com/LucasNarlochZ/agent-iam/actions/workflows/ci.yml/badge.svg?event=pull_request)](https://github.com/LucasNarlochZ/agent-iam/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js: >=20](https://img.shields.io/badge/Node.js-%3E%3D20-339933)](https://nodejs.org/)

Give your coding agents permission to do useful work without giving them permission to do everything your credentials allow.

Agent IAM checks intercepted Git, GitHub CLI, AWS CLI, and supported GitHub MCP actions against your policy. It denies actions by default and records authorization attempts. Allow routine work, deny sensitive operations, and approve new capabilities as you need them.

**Build permissions as you work—not by hand-editing YAML.** Initialize a policy, launch your agent, and approve supported CLI and GitHub MCP capabilities when they are needed. Agent IAM saves permanent decisions for you, with supported repository, branch, or staged-path restrictions. See [progressive permissions](#progressive-permissions).

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

## Why add Agent IAM to native permissions?

Codex, Claude Code, and OpenCode already provide permission controls and interactive approvals. Agent IAM complements those controls with a shared, capability-based policy for supported service actions:

| Native system | What it provides | What Agent IAM adds |
| --- | --- | --- |
| [Codex](https://developers.openai.com/codex/agent-approvals-security) | Sandbox boundaries, approval policies, and command-prefix execution rules. | Service capabilities such as `github.pr.merge`, with supported context restrictions, reusable outside Codex. |
| [Claude Code](https://code.claude.com/docs/en/permissions) | Tool permissions, Bash command patterns, MCP tool rules, and approval modes. | One capability rule for equivalent supported CLI and GitHub MCP actions, rather than separate rules for each tool interface. |
| [OpenCode](https://opencode.ai/v2/docs/permissions) | Tool/action and resource rules, shell command patterns, and saved project approvals. | A policy shared with Codex and Claude Code, plus supported repository, branch, and staged-path constraints on normalized capabilities. |

The advantage is **portable service permissions**, not simply fewer prompts: keep the same Agent IAM policy when switching agents, approve capabilities progressively, and inspect authorization decisions in one audit log. For example, a `github.pr.merge` deny applies to both intercepted `gh pr merge` commands and supported GitHub MCP merge calls.

Keep native permissions and sandboxing enabled where available. Agent IAM does not replace filesystem or network isolation, cover every native tool, or prevent [bypasses outside interception](#security-limits).

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

To initialize a directory policy in the current directory instead:

```bash
agentiam init --local
```

This creates `./.agentiam/policy.yaml` without changing the home-directory policy. It does not overwrite an existing local policy. Directory policies can grant permissions missing globally, but matching explicit denies in any applicable policy still take precedence.

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

## Progressive permissions

You do not need to anticipate every capability or edit YAML each time your agent needs a new permission. For supported actions with no matching allow rule, Agent IAM can ask through your terminal or supported native agent interface for CLI commands, or through MCP form elicitation for intercepted GitHub MCP calls:

1. Choose **Allow permanently**, **Allow once**, **Deny permanently**, or **Skip**.
2. For permanent decisions, choose a supported scope, such as the current repository, branch, or staged paths.
3. Choose the global or local policy when a policy exists in the command's current directory. Agent IAM writes the rule for you.

**Allow once** runs that invocation without saving a rule. After saving a permanent allow, retry the command or MCP call; subsequent matching actions use the saved permission.

Explicit denies never prompt and cannot be overridden by approval. MCP approvals require a client that supports form elicitation; otherwise, configure rules beforehand. Invalid policies, unsupported capabilities, and unavailable approval channels remain denied. See [approvals](docs/POLICIES.md#interactive-approvals) for requirements and details.

## Your policy, your permissions

Policies remain readable YAML, so you can review saved decisions or edit `~/.agentiam/policy.yaml` directly when you want to:

```yaml
allow:
  git.add: true
  git.commit: true
  github.issue.list: true
deny:
  git.push: true
  github.pr.merge: true
```

Explicit denies take precedence. Project policies can grant permissions or deny actions, and supported rules can be scoped by repository, branch, or staged paths.

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

## Automated tests and real-harness integration

Agent IAM has automated unit and integration tests for policy evaluation, command normalization, approvals, and audit records. Integration suites also run **real Codex, Claude Code, and OpenCode CLIs**, not just mocked harness interfaces.

From a repository checkout with dependencies installed:

```bash
npm test                 # Build and run unit/integration tests without real harnesses
npm run test:isolated    # Complete suite, including real harnesses, in Docker
```

CI runs formatting, typechecking, build checks, and the isolated suite. The Docker image pins harness versions; tests run with external networking disabled, temporary configuration, scripted local servers, and fake service executables—no live model inference or API credentials. On Linux, Codex tests also answer its real terminal approval dialogs and verify saved rules, retries, and audit events. Claude Code coverage does not exercise interactive approval dialogs.

The isolated suite requires a running Docker daemon and network access to provision the image. See the [development guide](docs/DEVELOPMENT.md#isolated-tests) for prerequisites, coverage limits, and commands to test locally installed harness versions.

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

