# Changelog

All notable changes to `@pharaoh-so/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Codex gets the review skill as `$pharaoh-review` in `~/.agents/skills/` when `~/.codex/` exists. No other skill and no other file there is touched.

### Changed
- The review skill's adversarial pass (Phase 3) asks the other model: Codex when run in Claude Code, Claude when run in Codex. The second reviewer is read-only, has no MCP servers, apps, plugins, hooks or web access, and uses only a subscription login. When that CLI is missing or signed out, a same-model subagent reviews instead and the review says so.

## [0.3.50] - 2026-10-20

### Changed
- Tighten Trace card spacing without shrinking text or hiding evidence.
- Stop requesting a duplicate ASCII panel when a usable Trace view is attached. Keep the complete insight available to the agent and preserve text-only output.

## [0.3.49] - 2026-10-20

### Changed
- Publish from the standalone public source repository with npm provenance, after the reviewed source passes its required checks.
- Include the test runtime needed to validate the package independently.

## [0.3.48] - 2026-10-20

### Added
- Compact Trace views for supporting MCP App clients, with expandable evidence, yellow bars and green success markers. Existing text results remain available.
- The same static Trace resource before and after sign-in. Resource reads do not start device authentication, and view data comes only from authorized tool results.

## [Unreleased]

Security review of 2026-10-17 (findings SC-2, SC-6, SC-7, SC-8, SC-9). See README § Security for what the installer writes.

### Changed
- The interactive setup allow-lists Pharaoh's six read-only tools and `pharaoh_account` by full name in `~/.claude/settings.json`, only when that file already exists, and says so. It replaces the blanket `mcp__pharaoh` rule earlier versions wrote on every start, which also auto-approved account deletion and `pharaoh_admin`. Proxy starts no longer touch permissions.
- Slash command files in `~/.claude/commands/` are written only when absent or Pharaoh's own (front-matter marker `# managed-by: pharaoh-mcp`, or the header and `$ARGUMENTS` footer of an earlier install). A user's file with the same name is kept and named in the output; symlinks are never followed.
- `~/.pharaoh` is created `0700` and set to `0700` on every start, whichever path creates it first.
- Every registration (`claude mcp add`, OpenClaw, the shipped `.mcp.json`) runs `npx @pharaoh-so/mcp@<the installed version>`. Upgrading is `npx @pharaoh-so/mcp@latest`; the interactive setup prints a hint when the registry has a newer version.
- `package.json` `repository` names the building repository. The release workflow requests npm provenance when the source repository is public; private-source releases publish without it.

## [0.1.5] - 2026-03-24

### Added
- Inspect mode (`--inspect`) for MCP registry validation and debugging
- Tool manifest JSON output for Glama and other MCP registries

### Fixed
- Improved error messages for connection failures

## [0.1.3] - 2026-03-23

### Added
- `inspect-tools.json` bundled in package for offline tool schema access

### Changed
- Updated `@modelcontextprotocol/sdk` to ^1.26.0

## [0.1.2] - 2026-03-22

### Fixed
- Credential file permissions set correctly on first write
- Token refresh race condition when multiple requests arrive simultaneously

## [0.1.0] - 2026-03-20

### Added
- Initial release
- Stdio-to-SSE proxy for headless Pharaoh MCP connections
- RFC 8628 device authorization flow
- Automatic token refresh
- Credential storage with restrictive file permissions (`0600`)
- `--server` flag for custom Pharaoh instances
- `--logout` flag to clear stored credentials
- Support for all 19 Pharaoh MCP tools
