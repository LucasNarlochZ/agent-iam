# Changelog

## [Unreleased]

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
