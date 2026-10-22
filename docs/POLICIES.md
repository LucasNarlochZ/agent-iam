# Policies and approvals

Agent IAM reads the global user policy from `~/.agentiam/policy.yaml`. Create it from the [example policy](../examples/policy.yaml), then inspect it:

```bash
agentiam init
agentiam inspect policy
```

`init` does not overwrite an existing policy. `inspect policy` shows the global policy and its constraints, not a merged view of directory restrictions. Bare `agentiam inspect` now prints subcommand usage; use `agentiam inspect policy` in existing scripts.

## Allow and deny rules

Rules use exact [capability names](CAPABILITIES.md):

```yaml
allow:
    git.add: true
    git.commit: true
    github.issue.list: true
    github.pr.view:
        repos: [my-org/my-repo]
    aws.sts.get-caller-identity: true
deny:
    git.push: true
    github.pr.merge: true
    aws.s3.rm: true
```

An explicit deny always wins over an allow. Unmatched capabilities are denied. Capability names and constraint names are validated against the supported registry; missing or invalid policy files also deny execution.

Use `true` for a capability-wide rule. Contextual rules can constrain supported capabilities by repository, current branch, or staged paths. See [supported commands](CAPABILITIES.md) for where each constraint is available. GitHub repository constraints are compared case-insensitively across CLI and MCP calls.

## Directory policies

Agent IAM also reads `.agentiam/policy.yaml` from the current directory and each parent directory. These policies can only add restrictions to the global policy:

- Deny rules block additional matching actions.
- Allow rules add required constraints to actions already allowed globally.
- A directory policy cannot allow an action denied or omitted globally.

For example, this project policy prevents merges even when the global policy allows them:

```yaml
deny:
    github.pr.merge: true
```

An invalid directory policy fails closed and denies the action.

## Interactive approvals

When a supported CLI capability has no matching allow rule, Agent IAM can prompt for approval. Use the arrow keys to select an option and Enter to confirm. Escape or Ctrl+C selects **Skip**.

Depending on the available context and agent interface, choices include:

- **Allow this capability**: save an unrestricted allow rule.
- **Allow for this context**: save an allow rule for the current repository, branch, or staged paths.
- **Allow once**: run the denied command without changing policy, when offered by the interface.
- **Explicitly deny**: save a deny rule.
- **Skip**: leave policy unchanged and keep the command denied.

Persistent choices update `~/.agentiam/policy.yaml`. Saving an allow rule does not execute the denied command; retry it to apply the change. **Allow once** is the exception: it permits that invocation without saving a rule.

Existing explicit denies do not prompt. Unsupported capabilities, invalid policies, and audit failures deny without prompting. GitHub MCP tool calls also deny without interactive approval; configure their rules beforehand.

When running directly in a terminal, both stdin and stderr must be attached to a TTY. Wrapped agents can use a parent terminal or a native approval bridge. If neither is available, the action remains denied. See [agent integrations](INTEGRATIONS.md) for native-interface requirements.

## Troubleshooting a missing prompt

1. Check the capability in the `[agentiam] DENY ...` message against [supported commands](CAPABILITIES.md). For example, `github.issues.list` is unsupported; the correct command is `gh issue list`.
2. Run `agentiam inspect policy` and check for an explicit deny. Also check directory policies.
3. Check for policy-loading or audit-write errors. Both prevent approval.
4. Use an interactive terminal or a supported native agent approval bridge. Pipes and non-interactive execution do not provide a terminal prompt.

Use `agentiam inspect logs --tail 10` to see the decision reasons. Authorization attempts and approval outcomes are recorded in `~/.agentiam/audit.jsonl`; see [audit logs](OBSERVABILITY.md).
