# Policies and approvals

Agent IAM reads the global user policy from `~/.agentiam/policy.yaml`. Create it from the [example policy](../examples/policy.yaml), then inspect it:

```bash
agentiam init
agentiam inspect policy
```

`init` does not overwrite an existing policy. `inspect policy` shows the global policy and its constraints, not a merged view of directory policies. Bare `agentiam inspect` now prints subcommand usage; use `agentiam inspect policy` in existing scripts.

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

## Git branch constraints

Use `branches` to restrict `git.add` and `git.commit` to named branches:

```yaml
allow:
    git.add:
        branches: [feature/work]
    git.commit:
        branches: [feature/work]
```

This example does not allow these actions on other branches or when branch detection fails. A separate capability-wide allow can still grant permission. To block commits on protected branches regardless of other allows, use an explicit deny:

```yaml
deny:
    git.commit:
        branches: [main, master]
```

Branch names are matched exactly, not as glob patterns. For add and commit, these constraints use the current branch. Push constraints use explicit destination branches when supplied. For `git.commit`, a rule may include both `branches` and `paths`; both must match.

## Git force and operation constraints

Both `git push --force origin main` and `git push -f origin HEAD:main` normalize to `git.push` with `branches: ["main"]` and `force: true`. Policy values remain arrays of strings:

```yaml
allow:
    git.worktree.list: true
    git.worktree.add:
        force: ["false"]
    git.remote.get-url: true
    git.push:
        branches: [main]
        force: ["false"]
deny:
    git.push:
        branches: [main]
        force: ["true"]
```

This allows ordinary pushes to main and denies force pushes to main. `--force-with-lease`, `--mirror`, and refspecs beginning with `+` also count as force pushes. Separate capabilities let you allow remote inspection without granting `git.remote.set-url` or `git.remote.remove`.

## Directory policies

Agent IAM also reads `.agentiam/policy.yaml` from the current directory and each parent directory. Rules from all applicable policies are evaluated together:

- A matching explicit deny in any global or directory policy blocks the action, regardless of allow rules elsewhere.
- Otherwise, a matching allow in any applicable policy grants permission, including when the global policy omits the action or its allow constraints do not match.
- Without any matching allow, the action remains denied.

Allow rules are additive: a narrower directory allow does not restrict a broader global or ancestor allow. Use explicit deny rules to block actions. Review directory policies before running an agent in a repository, because they can grant permissions.

Use `agentiam init --local` to create `.agentiam/policy.yaml` in the current directory. The global policy is still required.

For example, this project policy prevents merges even when the global policy allows them:

```yaml
deny:
    github.pr.merge: true
```

An invalid directory policy fails closed and denies the action.

## Interactive approvals

When a supported capability has no matching allow rule, Agent IAM can prompt for approval. CLI commands use a terminal or native approval bridge; intercepted GitHub MCP calls use the MCP client's form elicitation interface. In the terminal, use the arrow keys to select an option and Enter to confirm. Escape or Ctrl+C selects **Skip**.

Approval takes at most three questions. The first offers:

- **Allow permanently**: save an allow rule after choosing its scope and destination.
- **Allow once**: run the denied command or MCP call without changing policy or asking further questions.
- **Deny permanently**: save a deny rule after choosing its scope and destination.
- **Skip**: leave policy unchanged and keep the command denied.

For permanent decisions, the second question offers all contexts of the action or a supported restriction, such as the current repository, branch, or staged paths. Actions without available scope controls skip this question.

If the command's current directory contains `.agentiam/policy.yaml`, the final question offers the global and local policies, showing each full path. Otherwise, rules are saved to `~/.agentiam/policy.yaml` without a destination question. Ancestor-directory policies are not offered as local destinations. Cancelling any question leaves policy unchanged.

Local allow rules can grant missing global permissions, but cannot override matching explicit denies in any applicable policy. Saving an allow rule does not execute the denied command or MCP call; retry it to apply the change. **Allow once** is the exception: it permits that invocation without saving a rule.

Existing explicit denies do not prompt. Unsupported capabilities, invalid policies, and audit failures deny without prompting. GitHub MCP approvals require a client advertising form elicitation support; clients without it remain denied unless a policy rule already allows the call. MCP approval cancellation, timeout, persistence errors, or failed audit writes also leave the call denied. See [MCP approvals](MCP.md#interactive-approvals) for details.

When running directly in a terminal, both stdin and stderr must be attached to a TTY. Wrapped agents can use a parent terminal or a native approval bridge. If neither is available, the action remains denied. See [agent integrations](INTEGRATIONS.md) for native-interface requirements.

## Troubleshooting a missing prompt

1. Check the capability in the `[agentiam] DENY ...` message against [supported commands](CAPABILITIES.md). For example, `github.issues.list` is unsupported; the correct command is `gh issue list`.
2. Run `agentiam inspect policy` and check for an explicit deny. Also check directory policies.
3. Check for policy-loading or audit-write errors. Both prevent approval.
4. Use an interactive terminal or a supported native agent approval bridge. Pipes and non-interactive execution do not provide a terminal prompt.

Use `agentiam inspect logs --tail 10` to see the decision reasons. Authorization attempts and approval outcomes are recorded in `~/.agentiam/audit.jsonl`; see [audit logs](OBSERVABILITY.md).
