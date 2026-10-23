# Development

## Local setup

Use Node.js 20 or newer and a POSIX environment. From the repository root:

```bash
npm install
npm run build
node dist/index.js --version
```

Check changes before submitting:

```bash
npm run format:check
npm run typecheck
npm test
```

Before opening any pull request, also run `npm run test:isolated`. Fix failures and rerun the complete isolated suite before creating the PR; fast local tests alone are not sufficient. If Docker or another prerequisite is unavailable, report the blocker instead of opening an unverified PR.

## Extending integrations

Built-in tool integrations are registered in [`src/registry/builtins.ts`](../src/registry/builtins.ts). Adding a command-only tool integration requires an adapter class and a registry entry; shim creation, CLI validation, auditing, and policy capability validation derive metadata from that registry. Service capability definitions and policy constraint extraction live in [`src/services/`](../src/services/).

When adding a capability, update the [command reference](CAPABILITIES.md) and tests for normalization, policy validation, and approval behavior. Registration must not automatically grant permission. See [architecture](ARCHITECTURE.md) for source entry points and enforcement boundaries.

Tests use temporary homes and fake binaries so they do not modify a developer's real Agent IAM configuration.

## Fast local tests

`npm test` builds Agent IAM and runs unit and integration tests, excluding the real Claude Code, Codex, and OpenCode suites. It uses installed project dependencies and requires no Docker daemon or installed coding harnesses. Test filters are forwarded to Vitest:

```bash
npm test
npm test -- tests/unit/policy.test.ts
```

`npm run test:watch` runs Vitest directly on the host using your local setup. It includes real-harness suites when their CLIs are available. Build Agent IAM first when testing changes exercised through `dist/index.js`.

## Isolated tests

`npm run test:isolated` builds a Docker image and runs the complete suite, including real CLI integration tests, in a disposable container. It requires a running Docker daemon. Local Claude Code, OpenCode, Codex, dependencies, build output, credentials, and configuration are not used. Filters are forwarded to Vitest:

```bash
npm run test:isolated
npm run test:isolated -- tests/integration/real-claude.test.ts
npm run test:isolated -- tests/integration/real-opencode.test.ts
npm run test:isolated -- tests/integration/real-codex-tui.test.ts
```

The image pins Node.js 24.21.0 by digest, installs Zsh from a dated Debian package snapshot, and installs project dependencies with `npm ci`. Claude Code 2.1.308, Codex 0.162.1, and OpenCode 2.0.29 are pinned in [`tests/harnesses/package.json`](../tests/harnesses/package.json), with transitive dependencies locked in its adjacent lockfile. Keep those versions consistent with [`tests/harness-versions.json`](../tests/harness-versions.json); the image build checks this.

Image provisioning requires registry and Debian snapshot access. Docker caches installation layers for subsequent runs. External networking is disabled in the test container; loopback remains available for scripted local servers. No host directories are mounted, and the container is removed after execution. CI runs the same command.

On Linux, Claude Code tests use a local scripted Messages API server and fake AWS executable to check allowed commands, explicit denials, and noninteractive approval requests. They verify MCP connectivity, execution, and audit records without real model inference or credentials. They do not exercise interactive Claude approval dialogs. Commands needing approval remain denied when the native approval socket is unavailable, including during startup.

## Local CLI compatibility tests

Use installed CLIs from your local `PATH` to check compatibility:

```bash
npm run test:real:codex
npm run test:real:opencode
npm run test:real
```

These commands build Agent IAM and run the selected real CLI suites without installing or replacing your tools. They require local project dependencies, a POSIX environment, and the selected CLIs on `PATH`; missing tools cause an error. Installed versions are printed before testing. Incompatible versions can fail these tests: the OpenCode native-plugin fixture requires V2.

Codex tests use a local scripted Responses API server, isolated `HOME` and `CODEX_HOME` directories, and fake Git or AWS executables. They check allowed and denied shell commands, argument forwarding, tool results, and audit records. OpenCode tests check the plugin bridge against a private server using a scripted command and native permission reply. Both use temporary configuration without model inference or API credentials.

### Codex terminal dialog tests

On Linux, the Codex suite also launches `agentiam run -- codex` in a pseudo-terminal and answers the real native approval dialog with keyboard input. It covers allow, allow once, explicit deny, skip, Escape cancellation, and unavailable elicitation with approval policy `never`. Assertions check policy persistence, initial execution, a subsequent retry, and audit records.

These tests run in `test:isolated` and `test:real:codex`, but not `npm test`. TUI cases are skipped outside Linux. Local runs require util-linux `/usr/bin/script` and `stty`, already present in the isolated image.

The terminal driver uses fixed dimensions, answers terminal capability queries, and waits for matching output to settle for 100 milliseconds before sending a key. Codex drains queued input when opening security-sensitive dialogs, so sending a key as soon as its label appears can discard the answer. Timeouts include a terminal transcript for diagnosis. These are behavioral dialog tests, not visual snapshot tests.

The test subprocess uses `danger-full-access` so it does not depend on host sandbox support. Only scripted tool calls are returned by the local server; these tests validate Agent IAM interception, not Codex sandboxing.
