# Audit logs

Inspect recent decisions without opening the JSONL file:

```bash
agentiam inspect logs
agentiam inspect logs --tail 50
agentiam inspect logs --head 10
agentiam inspect logs --tail 50 --json
```

Logs are read from `~/.agentiam/audit.jsonl` using the current user's home directory. Reading logs does not load policy, change configuration, or create an audit file.

## Command options

| Option       | Behavior                                                 |
| ------------ | -------------------------------------------------------- |
| No options   | Show the latest 20 valid records.                        |
| `--tail [N]` | Show the last N valid records; default 20.               |
| `--head [N]` | Show the first N valid records; default 20.              |
| `--json`     | Emit one JSON object per line instead of formatted text. |

Counts must be positive integers. `--head` and `--tail` are mutually exclusive. Both preserve file order, oldest to newest within the selected records. These commands read a snapshot; `--tail` does not follow new writes.

The reader streams the file and retains at most the selected number of records. Blank lines are ignored. Invalid or partially written records are skipped with a line-number warning on stderr, without printing their contents. Counts apply to valid records; `--head` stops after finding enough. An empty log produces no records. A missing log prints a notice on stderr and exits successfully without creating a file; other read errors exit with code 1.

## Command output

CLI actions allowed by existing policy produce no Agent IAM terminal message; the command's own output is unchanged. Explicit and default denials are reported on stderr. Allow-once approvals and saved policy changes produce brief confirmations on stderr. Saving an allow rule still requires retrying the command.

Authorization and approval events remain audited even when terminal output is silent. Internal errors are reported on stderr and audited when possible; an unavailable audit log cannot record its own failure.

## Reading a decision

Formatted records include the timestamp, decision, capability, reason, policy path, and command:

```text
2026-10-22T12:00:00.000Z DENY git.add
  Reason: no allow rule for git.add in global policy (default deny) [no_allow_rule]
  Policy: /home/user/.agentiam/policy.yaml (global)
  Command: git add README.md
```

Control characters are escaped in formatted output so log content cannot insert terminal commands or forge extra lines. `--json` retains structured fields and uses JSON escaping.

New authorization records include:

- `requestId`: identifier shared with any approval outcome for the same CLI invocation.
- `event`: `authorization` for the policy decision, `approval` for the later user/broker outcome, or `error` for a CLI normalization or execution error.
- `decision`: `ALLOW` or `DENY` for that event, not proof of command success.
- `reason`: a readable explanation, including expected and actual context for constraint mismatches.
- `reasonCode`: a machine-readable category.
- `policyPath`: the decisive policy file; directory denials identify the directory policy, not just the global file.
- `policyScope`: `global` or `directory` when evaluation reaches a policy decision.
- `capability`, `tool`, `command`, `arguments`, and `timestamp`: the intercepted action and when authorization occurred.

Policy-loading failures may have no scope because evaluation did not complete. Existing records without the new optional fields are still supported; they retain their original reasons and are not retroactively enriched.

### Reason codes

| Code                                       | Meaning                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `allow_rule`                               | A matching allow rule authorized the action.                                |
| `deny_rule`                                | A matching explicit global or directory deny blocked the action.            |
| `no_allow_rule`                            | The policy has no allow rule for the capability; default deny applies.      |
| `constraint_mismatch`                      | An allow rule exists but the action's context does not satisfy it.          |
| `unsupported_capability`                   | The CLI capability or MCP tool/arguments are unsupported.                   |
| `policy_error`                             | Policy loading or evaluation failed.                                        |
| `allow_once`                               | The user allowed this invocation without changing policy.                   |
| `approval_allow`, `approval_allow_context` | An allow rule was saved; the invocation remains denied and must be retried. |
| `approval_deny`, `approval_deny_context`   | The user saved an unrestricted or scoped explicit deny rule.                |
| `approval_skip`                            | Approval was skipped or unavailable; the action remains denied.             |
| `approval_error`                           | A selected policy change could not be saved; the action remains denied.     |
| `execution_error`                          | The CLI executable could not be resolved or started.                        |
| `normalization_error`                      | The CLI adapter failed to identify the requested capability.                |

## Policy decisions versus approval outcomes

A default denial can produce two events with the same `requestId`: the initial `authorization` decision and the later `approval` outcome. An allow-once outcome records `ALLOW` before execution. Saving a permanent allow records `DENY` for the current invocation and explains that a retry is required. Approval events include the selected `approval` choice.

Filter by `event` when counting policy decisions; counting every record counts approval outcomes too. An audit-write failure blocks execution and is reported on stderr; an unavailable log cannot reliably record its own failure. An earlier authorization record can remain even if a later approval audit write fails. Policy changes already saved are not rolled back in that case.

## Privacy and limits

CLI audit records include the original arguments. Avoid putting credentials or other secrets in command arguments and treat the audit file as sensitive. GitHub MCP records contain only supported tool names and normalized capability/repository context, not raw call arguments or tool results. Policy-loading errors for MCP use sanitized categories rather than raw parser errors.

Audit records describe authorization and CLI execution errors, not process completion, exit status, or upstream success. See [architecture](ARCHITECTURE.md#audit-log) for audit delivery, sandbox requirements, and failure semantics.
