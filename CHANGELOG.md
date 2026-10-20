# Changelog

## [0.3.0](https://github.com/LucasNarlochZ/agent-iam/compare/core-v0.2.0...core-v0.3.0) (2026-10-20)


### Features

* add AWS CLI policy enforcement ([717a5df](https://github.com/LucasNarlochZ/agent-iam/commit/717a5df12becabc0e832059f482dcabf8a5ee228))
* add Claude Code approval support ([aa835f1](https://github.com/LucasNarlochZ/agent-iam/commit/aa835f173e6ee22e0a7387e8caec08e3f5a02e86))
* add interactive approval prompts ([23ecabd](https://github.com/LucasNarlochZ/agent-iam/commit/23ecabd3403360daa79798df0fb0505e1c9aac38))
* add interactive approvals and harness integrations ([28510ab](https://github.com/LucasNarlochZ/agent-iam/commit/28510abc41bc757c65f2d50919ed8a743808d1bf))
* add native Codex approvals and preserve shell interception ([2253261](https://github.com/LucasNarlochZ/agent-iam/commit/2253261d8d22515d0e36d6e5e645fb8bb8c51096))
* add native OpenCode approval bridge ([9eb4112](https://github.com/LucasNarlochZ/agent-iam/commit/9eb4112e429720c246ca6ef06075eafb9a4657c9))
* add one-time approval option ([009e3e3](https://github.com/LucasNarlochZ/agent-iam/commit/009e3e38098002e8ab01be9f7a79ecd81b7bd9a2))
* add prolog capability policy engine ([d20a274](https://github.com/LucasNarlochZ/agent-iam/commit/d20a2743f38fc7ed04c3c6f3eb24282d1984e0ad))
* add scoped policy constraints ([9136065](https://github.com/LucasNarlochZ/agent-iam/commit/913606569af197ea3284e1353fac7d0bdb01c62c))
* add view to example policy ([b54a52a](https://github.com/LucasNarlochZ/agent-iam/commit/b54a52a44fe7ef6704a6c7ff969dc541f4be9700))
* allow essencial git commands ([4dfea09](https://github.com/LucasNarlochZ/agent-iam/commit/4dfea0957607234ce484ae2c3b05fe8c497ddae4))
* centralize tools and broker approvals ([cc11060](https://github.com/LucasNarlochZ/agent-iam/commit/cc1106050e45bbdff268441a16a2fb0b650eca08))
* enforce policies through path shims ([945d15f](https://github.com/LucasNarlochZ/agent-iam/commit/945d15f2ef3f422c098b0f7a9e555216713144d7))
* granular permissions per constraint ([147c98f](https://github.com/LucasNarlochZ/agent-iam/commit/147c98fc51cf0fbdce2943c562d67842d706a21f))
* init command ([cd49524](https://github.com/LucasNarlochZ/agent-iam/commit/cd4952451ac3d296a4bd53dca08238943afe86e6))
* new allowed commands ([1dbc2a7](https://github.com/LucasNarlochZ/agent-iam/commit/1dbc2a7915e8a8c58331581fa91d1c806fe1e958))
* new allowed commends on policy ([202274a](https://github.com/LucasNarlochZ/agent-iam/commit/202274a96cc67014824f3c47855043d69045417f))
* scoped policy ([f3e4fc3](https://github.com/LucasNarlochZ/agent-iam/commit/f3e4fc32ffa9f2eb924d241c66ada3754d59f5ad))
* support OpenCode V1 harness ([8bc249c](https://github.com/LucasNarlochZ/agent-iam/commit/8bc249cbb6b4c9f648c11d0277bdd42d62196131))
* update ([86180a3](https://github.com/LucasNarlochZ/agent-iam/commit/86180a34dacf70d370b53d30a83a2f58db6a039a))
* update ([a119caf](https://github.com/LucasNarlochZ/agent-iam/commit/a119caf6cd5ce2ec1ebf5d6715f87bc6f53293cb))


### Bug Fixes

* broker auditing and approvals outside Codex sandbox ([00559c3](https://github.com/LucasNarlochZ/agent-iam/commit/00559c304714b0328bee4e98386fc36b505b6991))
* explain unavailable Codex approvals ([03ecf0c](https://github.com/LucasNarlochZ/agent-iam/commit/03ecf0c140df61364fb4f39d1c35162395993f8b))
* use correct OpenCode V2 CLI package for integration tests ([1bed470](https://github.com/LucasNarlochZ/agent-iam/commit/1bed470f9d73845e6285e29cdac6d867c317d012))

## [0.3.0] - 2026-10-19

### Added

- Add interactive TTY prompts for saving unrestricted, context-specific, or explicit deny rules after default-denied actions
- Add end-to-end AWS CLI normalization and policy enforcement using `aws.<service>.<operation>` capabilities
- Add a parent-process approval broker for commands launched inside agents with non-TTY streams
- Add native Codex approval prompts through a temporary MCP elicitation server

### Changed

- Centralize adapter, shim, capability, constraint, approval, and audit metadata in one tool registry
- Replace numbered approval input with an arrow-key terminal selector

### Fixed

- Preserve command interception when Codex or a login shell replaces the inherited `PATH`

## [0.2.0] - 2026-09-18

### Added

- Add granular Git and GitHub policy constraints
- Add `agentiam init` to create the default user policy
- Add inherited directory-scoped policies that can only further restrict global policy rules

### Changed

- Rename capability metadata from `resources` to `constraints`
