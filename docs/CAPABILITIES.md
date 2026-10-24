# Supported commands

Agent IAM intercepts `git`, `gh`, and `aws` in processes launched through `agentiam run`. Registration makes a command eligible for policy rules and interactive approval; it does not grant permission.

```bash
agentiam run -- git add README.md
agentiam run -- gh issue list
```

See [policies](POLICIES.md) for configuring permissions. Unsupported capabilities remain denied without prompting.

## Capability names

| CLI structure               | Capability format           | Example                       |
| --------------------------- | --------------------------- | ----------------------------- |
| `git <command>`             | `git.<command>`             | `git.add`                     |
| `gh <group> <command>`      | `github.<group>.<command>`  | `github.issue.list`           |
| `aws <service> <operation>` | `aws.<service>.<operation>` | `aws.sts.get-caller-identity` |

Unknown command structures are normalized deterministically and denied. Use `gh issue list`, not `gh issues list`. Aliases, extensions, and arbitrary `gh api` calls are not covered by the command lists below.

## Git

```text
add am apply archive bisect blame branch bundle checkout cherry-pick clean
clone commit config describe diff fetch grep init log ls-files ls-remote
merge mv pull push rebase reflog remote reset restore revert rev-parse rm
show stash status submodule switch symbolic-ref tag worktree
```

Worktree operations use separate capabilities: `git.worktree.add`, `list`, `lock`, `move`, `prune`, `remove`, `repair`, and `unlock` (each with the `git.worktree.` prefix).

Remote operations use `git.remote.add`, `rename`, `remove`, `set-head`, `set-branches`, `get-url`, `set-url`, `show`, `prune`, and `update` (each with the `git.remote.` prefix). `git remote rm` maps to `git.remote.remove`. Bare `git remote` and `git remote -v` retain `git.remote`; allowing it does not grant nested operations.

Other permissions apply to the whole subcommand. For example, allowing `git.branch` also allows branch deletion. All registered Git capabilities support `force` constraints using string values `"true"` and `"false"`. Force detection covers `--force`, short flags containing `-f`, and push `--force-with-lease` and leading `+` refspecs.

`git.add` and `git.commit` support `branches` constraints based on the current branch. `git.push` uses explicit refspec destinations, normalizing `refs/heads/main` to `main`; without refspecs it falls back to the current branch. Pushes using `--all`, `--branches`, `--mirror`, `--tags`, `--follow-tags`, wildcard refspecs, or non-branch refs omit branch context, so branch-constrained allow rules do not match. `git.commit` also supports `paths` constraints based on staged paths; when both constraints appear in a rule, both must match. Context lookups respect leading Git options such as `-C` and `--git-dir`. Rules may combine branch, path, and force constraints where supported; all constraints must match.

Branch-constrained allow rules do not match when the current branch is unavailable, including detached HEAD. Branch-constrained deny rules also do not match without branch context; they do not block a separate capability-wide allow. See [branch policy examples](POLICIES.md#git-branch-constraints).

## GitHub CLI

| Group      | Supported commands                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `issue`    | close, comment, create, delete, develop, edit, list, lock, pin, reopen, status, transfer, unlock, unpin, view                       |
| `pr`       | checks, checkout, close, comment, create, diff, edit, list, lock, merge, ready, reopen, review, status, unlock, update-branch, view |
| `repo`     | archive, clone, create, delete, edit, fork, list, rename, set-default, sync, unarchive, view                                        |
| `run`      | cancel, delete, download, list, rerun, view, watch                                                                                  |
| `workflow` | disable, enable, list, run, view                                                                                                    |
| `release`  | create, delete, delete-asset, download, edit, list, upload, view                                                                    |
| `auth`     | login, logout, refresh, setup-git, status, switch, token                                                                            |
| `search`   | code, commits, issues, prs, repos                                                                                                   |
| `gist`     | clone, create, delete, edit, list, rename, view                                                                                     |

Issue, PR, run, workflow, release, and `repo.view` capabilities support `repos` constraints. Repository names are compared case-insensitively. Other repo commands and the auth, search, and gist groups are capability-wide; their positional targets or account-wide effects are not scoped to the current repository.

## AWS CLI

AWS service/operation capabilities such as `aws.s3.cp`, `aws.s3.rm`, and `aws.sts.get-caller-identity` can be used in policies. AWS resource constraints are not extracted, so approvals are capability-wide.

## GitHub MCP

The GitHub MCP proxy shares GitHub capability names and repository constraints with the CLI adapter. Its exposed tools and argument restrictions are listed in [GitHub MCP](MCP.md#supported-tools). Registering a CLI capability does not expose an additional MCP tool.
