# Coding agent integrations

Initialize your [policy](POLICIES.md), then launch your agent through Agent IAM:

```bash
agentiam run -- codex
agentiam run -- opencode
agentiam run -- claude
```

The runner installs temporary CLI wrappers and approval bridges for that process. Recognized GitHub MCP servers can also be wrapped automatically; see [GitHub MCP](MCP.md) for discovery rules and enforcement limits.

## Codex

Agent IAM registers a temporary local MCP server and sends approval requests through MCP elicitation. Codex displays the choices in its native interface without Agent IAM taking over its terminal or pausing its TUI.

Codex must use an interactive approval policy that permits MCP elicitations. Otherwise, the request is skipped and the command remains denied.

Codex executes shell commands through login shells and controls their environment with `shell_environment_policy`. Agent IAM injects temporary paths into that policy and uses scoped Zsh, Bash, and POSIX shell startup files to restore the shim directory after user startup files run. The temporary MCP configuration and communication channels exist only for the wrapped process.

Sandboxed commands need access to Agent IAM's temporary approval and audit channel directories, not write access to `~/.agentiam`. Agent IAM does not broaden sandbox permissions. Channel behavior and timeouts are described in [architecture](ARCHITECTURE.md).

## OpenCode

Agent IAM detects the installed OpenCode CLI version:

- **V2:** uses native permission prompts through a temporary plugin and forces a private server with `--standalone`, so shell commands inherit the wrapped environment.
- **V1:** uses inherited shims and the regular terminal approval prompt, which requires a TTY. It does not load the V2 plugin or add V2-only flags.

Both versions reject `--server` and `--attach` connections. Existing OpenCode configuration stays in place; the V2 plugin is added only for the wrapped process. If `OPENCODE_CONFIG_CONTENT` is set, it must contain a JSON object.

The V2 TUI dialog offers **Allow this capability**, **Allow for this context** when available, **Explicitly deny**, and **Skip**. Allow and deny choices persist a policy rule; retry after saving an allow. If the custom dialog is unavailable, OpenCode's native permission prompt provides its standard approve/reject choices as a fallback.

Approvals are tied to the invoking tool's session, and the OpenCode interface is not paused. Commands outside a tool execution cannot use this bridge and remain denied when no rule allows them. The V2 integration is tested with OpenCode 2.0.29.

Automatic GitHub MCP wrapping requires V2; V1 prints a warning and leaves those servers outside Agent IAM enforcement.

## Claude Code

Agent IAM adds a temporary MCP server and uses Claude Code's native MCP elicitation question for denied CLI actions. Other CLI arguments are passed through unchanged and existing MCP configuration is retained.

The temporary server and socket are removed when Claude Code exits. If native elicitation is unavailable or no user can answer, the action remains denied.

Automatic GitHub MCP discovery has additional configuration and trust restrictions; see [automatic wrapping](MCP.md#automatic-wrapping).

## Other commands and agents

Any command can run inside the temporary shim environment:

```bash
agentiam run -- sh -c 'git commit -m "fix"'
```

For generic harnesses, the parent runner presents a terminal prompt and pauses the agent while the user decides. If neither the command nor the parent has a TTY, the action is denied without prompting.

These integrations are not a sandbox. Direct binary execution, alternative tools, and connections outside the configured proxy can bypass interception. See [security boundaries](ARCHITECTURE.md#goals-and-boundaries).
