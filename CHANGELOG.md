# Changelog

All notable changes to `@pharaoh-so/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `plugins/pharaoh/`: the Claude directory plugin, generated from the same skills (plan, review, refactor and pharaoh) with the hosted connector at `https://mcp.pharaoh.so/mcp`. It has no hooks or commands and isn't part of the npm package.
- `NOTICE`: the brainstorm, debug, tdd and verify skills are adapted from [superpowers](https://github.com/obra/superpowers) (MIT, Copyright (c) 2025 Jesse Vincent). Each skill's `license:` field says so too.

### Changed
- `/review` works as before, second opinion from Codex or Claude included. It no longer calls itself "the definitive code review", and Phase 0 says that `gh pr view` asks GitHub for the open PR's target branch with your gh login.
- `/plan` says "This is a review: make no code changes during it" instead of claiming plan mode. A plain "yes" or "yes to all" still doesn't pick BIG or SMALL, so it asks once more; if the reply still doesn't pick one, or you tell it to choose, it picks and says which. `.claude/plan-review.md` adds review criteria, and your own instructions come first.
- `pharaoh:refactor` runs the six steps its description lists: module context, blast radius, reachability, dependencies, naming conflicts, and a search for the tests to change.
- Skills install from `npx-skills/`, this package's build of `skills/`.
- `pharaoh_account` only reads now: your plan, live repo and upgrade link. Switching the live repo and refreshing a repo moved to the new `pharaoh_manage_repo`, which Claude Code asks about before it runs. The interactive setup's allow rules need no change: they already list the read-only tools, `pharaoh_account` among them, and leave `pharaoh_manage_repo` out.
- Every tool has a title, and the tool descriptions say what each tool returns instead of which other tool to avoid.
- The steering that used to sit in the server instructions moved to the npx `pharaoh` skill. Registrations are pinned to a version, so it takes effect when you upgrade. Codex gets only the review skill, so it doesn't get this.
- The `pharaoh` skill's connection URL is `https://mcp.pharaoh.so/mcp` instead of `/sse`. The skill also carries the guidance that was only in the server instructions: one Pharaoh call answers what grep and file reads take many turns to piece together, load Pharaoh's tools before the first code search when your client defers them, summarize a block marked "Trace view available" instead of reproducing it, and check related repos when a change touches shared interfaces.
- The server instructions state facts: what Pharaoh maps, which tool answers which question, what the graph leaves to grep, how repos are mapped and what each account tool does. Asking Pharaoh first, not re-checking its answers with grep, surfacing and crediting its ★ blocks and the rest of that guidance now live in the `pharaoh` skill. Claude Code and OpenClaw list the skill in every session and load its body only when they use it. The Grep hook and the optional `~/.claude/CLAUDE.md` line are unchanged and apply from the start of a session.

## [0.3.54] - 2026-10-24

### Added
- The interactive setup (`npx @pharaoh-so/mcp` in a terminal) asks once whether to add one line to `~/.claude/CLAUDE.md`: "In repos Pharaoh has mapped, before searching or reading files, ask Pharaoh where the relevant code is, what calls it, and whether what you need already exists." Enter means yes. In Pharaoh's adoption benchmark, Claude Code called Pharaoh first when this line was in a CLAUDE.md, and rarely when the same sentence came from the server instructions or a plugin hook.
- The line sits between `<!-- pharaoh-mcp:start … -->` and `<!-- pharaoh-mcp:end -->` markers. Setup appends that block or replaces the line inside it, and nothing else in the file changes. A symlinked file is left alone, and a proxy start (Claude Code launching the server) never asks or writes. Your answer is saved in `~/.pharaoh/claude-md-answer`, so a no stands.

### Changed
- `--clean` and `--logout` also remove that block, leaving the rest of the file byte for byte, and delete the saved answer so the next setup asks again.
- `--logout` deletes the saved credentials first, so a cleanup step that fails can't leave them behind.

## [0.3.53] - 2026-10-23

### Changed
- The Trace card is a compact receipt: the finding with its counts, a verdict such as risk, and one bar showing where the results sit (callers by module, dead or possibly unused, matches by module, code by module). The evidence opens on Details. A single-tool card is about 80px tall instead of 290 to 2,200px.
- While a tool runs, the card says what Pharaoh is doing ("Tracing callers of parseEvent…"). Caveats such as an incomplete graph or a stale map stay visible while the evidence is closed.

### Fixed
- With no `claude` CLI on PATH, `npx @pharaoh-so/mcp` stops before sign-in and says why: setup registers Pharaoh through that CLI, and the Claude desktop app's built-in Claude Code isn't on PATH. The message gives the CLI installer. It used to link the desktop app download, write the slash commands anyway and end with "Pharaoh is ready".
- When `claude mcp add` fails, setup ends without "Pharaoh is ready" and names the `claude mcp add` command to run by hand.

## [0.3.52] - 2026-10-23

### Added
- The proxy tells Pharaoh which client it serves (its `initialize` name and version) and whether Pharaoh's Claude Code plugin is enabled in `~/.claude/settings.json`, once per upstream session. Pharaoh stores it with that session, to compare adoption with and without the plugin. Nothing else is sent.

### Removed
- The `sessions` and `parallel` skills, the `/sessions` slash command and their MCP prompts (`session-decomposition`, `parallel-agents`). Claude Code and Codex now run subagents and parallel sessions on their own.
- The installer deletes the `~/.claude/commands/sessions.md` it wrote, only while it carries the `# managed-by: pharaoh-mcp` marker. A file of your own with that name, or a symlink, is kept.

### Fixed
- `npx @pharaoh-so/mcp --version` (or `-v`) prints the version and exits, as README § Custom Server says. It used to start setup: in a terminal it deleted saved credentials and signed in again against mcp.pharaoh.so; on a pipe it started the proxy.

## [0.3.51] - 2026-10-23

### Added
- Codex gets the review skill as `$pharaoh-review` in `~/.agents/skills/` when `~/.codex/` exists. No other skill and no other file there is touched.

### Changed
- The review skill's adversarial pass (Phase 3) asks the other model: Codex when run in Claude Code, Claude when run in Codex. The second reviewer is read-only, has no MCP servers, apps, plugins, hooks or web access, and uses only a subscription login. When that CLI is missing or signed out, a same-model subagent reviews instead and the review says so.
- `/review` always reaches a verdict: with no shell it reviews the diff it was given, without subagents it runs each reviewer pass itself, and the output names what was missing.

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
