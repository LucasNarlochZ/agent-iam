# Agent IAM

Control what your coding agents can do with Git, GitHub CLI, AWS CLI, and supported GitHub MCP tools.

Agent IAM checks intercepted actions against your policy, blocks them by default, and records authorization attempts. Allow routine work, deny sensitive operations, and approve new capabilities as you need them.

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
agentiam inspect
```

See the [policy guide](docs/POLICIES.md) and [supported commands](docs/CAPABILITIES.md) for available rules and their limits.

## Documentation

- [Policies and approvals](docs/POLICIES.md): configure permissions and troubleshoot denied commands.
- [Supported commands](docs/CAPABILITIES.md): Git, GitHub CLI, and AWS capabilities.
- [Coding agent integrations](docs/INTEGRATIONS.md): Codex, OpenCode, and Claude Code setup and compatibility.
- [GitHub MCP](docs/MCP.md): automatic wrapping, manual proxy setup, and supported tools.
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
