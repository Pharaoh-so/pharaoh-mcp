# Changelog

All notable changes to `@pharaoh-so/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Pharaoh updates itself when you say so. When the session-start notice says a release is out, ask your agent to update Pharaoh (`pharaoh_update`), and the version you already run checks the release; `npx @pharaoh-so/mcp@latest update` does the same from npm's newest code, which runs before it is checked, as with `install`. The release is installed into a private folder from registry.npmjs.org. It is kept only when npm's registry signature and its Sigstore build provenance from the publish workflow of `Pharaoh-so/pharaoh-mcp` match the installed bytes, and nothing is kept when Sigstore can't be reached. It becomes active at your next session start; the running session keeps its version. `~/.pharaoh/runtimes/mcp/update.log` records each step. Windows keeps updating with `install`.

### Changed
- `install` prepares Pharaoh while you sign in, then shows what's left on one line, with the step and the seconds so far (`Installing Pharaoh 0.3.83 · 4s`, then `Connecting Claude Code and Codex · 5s`), erased before the summary. A new version installs from the release npx just downloaded, with npm still checking every package, and goes online only when npm's cache can't supply that exact version. Piped and CI output is unchanged.
- `install` ends with a "Try Pharaoh in:" menu of your connected Claude Code and Codex, plus Skip: ↑/↓ and Enter pick, a number picks at once, and n or Esc skips. One agent gets the same menu instead of a yes/no question. The one you pick starts with the setup prompt, and the menu collapses to "Starting Claude Code…". Without either CLI there's no menu, and piped output still prints each agent's command.
- On macOS and Linux, `install` registers Claude Code, Codex and Claude Desktop, and the saved-worktree hooks, through a stable launcher (`~/.pharaoh/runtimes/mcp/launcher-v1.mjs`) instead of the versioned runtime path, so updates change no client setting. Codex asks you to trust Pharaoh's hooks once after this install, and not after later updates. Only the version the launcher runs writes the Claude Code plugin.
- `pharaoh-mcp` depends on `sigstore` 3.1.0, loaded only when an update runs.

### Fixed
- `--undo-memory` keeps its receipt when Pharaoh answers with its rate limit or a stale sign-in, so running it again finishes the undo; before, those records were left saved and the receipt was gone.

### Added
- An update notice at session start. When npm has a newer Pharaoh, the day's first Claude Code or Codex session shows one line, "Pharaoh 0.3.86 is available — you're on 0.3.84.", and every session gives your agent the update command (`npx @pharaoh-so/mcp@latest install`) and the restart step. Nothing shows while you're current, and a session never waits on the network: the proxy's daily background check keeps npm's latest in `~/.pharaoh/update-notice.json`. `install` adds the hook for each Claude Code and Codex client it connects, at a path that stays put across updates, so Codex asks you to trust it once in `/hooks`. `--logout` and `--clean` remove it. When an agent runs `install` for an existing sign-in, the output ends with "Restart … to use Pharaoh …" instead of commands that start another agent.
- Project memory saves by itself. When a turn edits code and a check (tests, a type check, lint or a build) then passes, the session-end hook asks your agent once to end its reply with the fix or decision and why, and saves that with a procedure built from what the hooks saw: the files edited, the check command and that it passed. A turn without that proof saves nothing. The session shows each save; `npx @pharaoh-so/mcp --undo-memory` removes the last one, and `npx @pharaoh-so/mcp --disable-memory-capture` stops automatic saving (`install --memory-hooks` turns it back on). Claude Code reports a check's exit status; Codex doesn't, so there a check counts only when the test runner's own summary shows it passed. Existing installs get the hooks at their next session start; Codex asks you to trust them in `/hooks` or Settings > Hooks.
- The background memory check at session start turns memory on for each repo as soon as the server confirms it, instead of waiting for the full list, and a check cut short by a short session no longer holds the next one off for an hour.
- The edit-time memory cue now comes with project memory, with no question: when your agent edits a file a project memory cites, it shows what the memory says about that file. Existing installs get it at their next session start; Codex asks you to review and trust the new hook in `/hooks` or Settings > Hooks. The structural hints (a Pharaoh query for a code grep, a note when an edited file differs from the mapped revision) stay a separate question, reworded plainly. `npx @pharaoh-so/mcp --disable-memory-hooks` turns all of it off; `pharaoh_setup` names it. Install prints memory lines only when something fails.
- `install` no longer waits to learn which of your repos have project memory. It sets up the memory hooks right away; they stay quiet until the check that runs in the background at your next session start confirms a repo, and install says so in one line.
- Project memory reaches sign-ins from before it existed. The proxy asks the server once a day, read-only, which of your repos have memory; no token rotates, and a failed check leaves your credentials untouched and retries in an hour. `install` asks too, so an existing sign-in gets the memory hooks without signing in again.
- When a Claude Code or Codex session starts, the proxy turns on the memory reminder hooks if they are missing, and says so once in a tool reply with the off command (`npx @pharaoh-so/mcp --disable-memory-hooks`). It never asks, and it leaves alone anyone who declined, Claude Code with `disableAllHooks`, and a Pharaoh hook entry you edited. Codex runs a new hook only after you review and trust it in `/hooks` or Settings > Hooks.
- `plugins/pharaoh/`: the Claude directory plugin, generated from the same skills (plan, review, refactor and pharaoh) with the hosted connector at `https://mcp.pharaoh.so/mcp`. It has no hooks or commands and isn't part of the npm package.
- `NOTICE`: the brainstorm, debug, tdd and verify skills are adapted from [superpowers](https://github.com/obra/superpowers) (MIT, Copyright (c) 2025 Jesse Vincent). Each skill's `license:` field says so too.

### Changed
- `install` ends in four lines in the usual case: who's signed in, which agents are connected, anything that needs you (a problem, or trusting Pharaoh's hook in Codex, shown only until you've trusted it), then the next step. In a terminal the last line asks to start Claude Code or Codex with "Run the Pharaoh setup tool." as the first message: Enter starts it, and with both installed Enter picks the first. Without a terminal, or with `CI` or `NO_COLOR` set, it prints each agent's command instead. Claude Desktop has no command to start, so it gets one line: open it (restart it after a new registration) and ask. The agent runs in the same terminal after install finishes, without npx's own `npm_*` variables; your npm credentials and registry settings stay. Project memory and the CLAUDE.md line no longer report at install unless something failed.
- Every tool declares `openWorldHint: false` (Pharaoh reaches only your own connected repos), and `pharaoh_account`'s description says it links the plans page.
- When a repo isn't live, and in `pharaoh_account` for free workspaces, replies link to the plans page on pharaoh.so instead of showing a price and a checkout link.
- `get_unused_code` says a Dead function's file has no import that could reach it, instead of "file not imported". An import that names other functions from the same file doesn't count, and never did.
- The Trace card draws its bars in block characters (`█ ▏ ░`) in your client's monospace font instead of solid CSS bars.
- `/review` works as before, second opinion from Codex or Claude included. It no longer calls itself "the definitive code review", and Phase 0 says that `gh pr view` asks GitHub for the open PR's target branch with your gh login.
- `/plan` says "This is a review: make no code changes during it" instead of claiming plan mode. A plain "yes" or "yes to all" still doesn't pick BIG or SMALL, so it asks once more; if the reply still doesn't pick one, or you tell it to choose, it picks and says which. `.claude/plan-review.md` adds review criteria, and your own instructions come first.
- `pharaoh:refactor` runs the six steps its description lists: module context, blast radius, reachability, dependencies, naming conflicts, and a search for the tests to change.
- Skills install from `npx-skills/`, this package's build of `skills/`.
- `pharaoh_account` only reads now: your plan, live repo and upgrade link. Switching the live repo and refreshing a repo moved to the new `pharaoh_manage_repo`, which Claude Code asks about before it runs. The interactive setup's allow rules need no change: they already list the read-only tools, `pharaoh_account` among them, and leave `pharaoh_manage_repo` out.
- Every tool has a title, and the tool descriptions say what each tool returns instead of which other tool to avoid.
- The steering that used to sit in the server instructions moved to the npx `pharaoh` skill. Registrations are pinned to a version, so it takes effect when you upgrade. Codex gets only the review skill, so it doesn't get this.
- The `pharaoh` skill's connection URL is `https://mcp.pharaoh.so/mcp` instead of `/sse`. The skill also carries the guidance that was only in the server instructions: one Pharaoh call answers what grep and file reads take many turns to piece together, load Pharaoh's tools before the first code search when your client defers them, summarize a block marked "Trace view available" instead of reproducing it, and check related repos when a change touches shared interfaces.
- The server instructions state facts: what Pharaoh maps, which tool answers which question, what the graph leaves to grep, how repos are mapped and what each account tool does. Asking Pharaoh first, not re-checking its answers with grep, surfacing and crediting its ★ blocks and the rest of that guidance now live in the `pharaoh` skill. Claude Code and OpenClaw list the skill in every session and load its body only when they use it. The Grep hook and the optional `~/.claude/CLAUDE.md` line are unchanged and apply from the start of a session.

## [0.3.77] - 2026-11-06

### Added
- Ask your agent to find something worth building or run a codebase audit from the Pharaoh setup card. Each choice has a chat fallback.
- Request a Codebase Health baseline with `get_codebase_map` for a source-verified audit.

## [0.3.76] - 2026-11-06

### Added
- Supported NPX coding sessions can answer callers and blast radius from the saved Git worktree. The agent sees local readiness before it supplies a selector. Pharaoh's local query path keeps source, paths, selectors and results on the machine.

## [0.3.75] - 2026-11-06

### Fixed
- Setup starts with one line: "Run the Pharaoh setup tool." The tool delivers the bounded investigation guidance to the agent, and Pharaoh's in-chat card keeps agent-only instructions out of its visible text.

## [0.3.74] - 2026-11-05

### Added
- Negotiated, finite model and installation-build metadata for runtime analytics. Claude Code keeps selected-model provenance across ordinary hooks and invalidates ambiguous lifecycle changes; Codex request observations remain explicitly uncorrelated.
- Registered-hook capability and daily build refresh distinguish recognized models from clients that can support a separately validated exploration estimate. No savings numbers are bundled with the package.

## [0.3.73] - 2026-11-05

### Changed
- Setup now hands you a complete request for your agent to investigate one useful thing you could build from existing capabilities, with three verified code links and Codebase Health as an ongoing goal. The request bounds the investigation to read-only work; the setup tool returns factual status, and the npx skill supplements the request without assuming setup invokes it.

## [0.3.72] - 2026-11-05

### Changed
- First-use guidance leads with a detected code dependency and a concrete work offer, then introduces Codebase Health progress and supported project-memory capabilities without claiming unmeasured savings or passive learning. Function references remain distinct from verified calls.

## [0.3.71] - 2026-11-05

### Changed
- New managed Claude Code and Codex connections can enable runtime analytics during ordinary device sign-in. `install --skip-runtime` and `--runtime-revoke` persist the choice to keep collection off.

## [0.3.70] - 2026-11-05

### Added
- Separate opt-in runtime analytics for supported local clients. Claude Code can report finite instruction-load and Pharaoh skill events, and Codex can report model-request counts. No instruction or skill text, local paths, prompts, transcripts or tool output is sent.
- `--runtime-enable`, `--runtime-status` and `--runtime-revoke` control collection without changing project-memory choices. `--doctor` reports local status offline.

## [0.3.69] - 2026-11-05

### Fixed
- Shell commands return exit code 1 for repository and other request refusals even when the MCP result has `isError: false`. A tool blocked by a plan that allows only the codebase map returns 4. Successful searches with no matches return 0.

## [0.3.68] - 2026-11-05

### Added
- Reports the native client's configured memory reminder state independently of diagnostic content collection. Configured hooks remain separate from host trust and execution.

### Fixed
- Installer import ordering passes the standalone public package lint gate.

## [0.3.67] - 2026-11-05

### Added
- `--doctor` reports bounded local Pharaoh plugin and instruction markers offline, without sign-in, uploads or changes. Project markers stay unknown unless the user selects a verified client with `--client claude-code` and runs from a repository root. It does not inventory skills or inspect the configured package pin.

### Changed
- Local instruction and plugin observations honor an absolute `CLAUDE_CONFIG_DIR`. Unreadable or invalid plugin settings report unknown rather than absent.

## [0.3.66] - 2026-11-05

### Added
- Optional project-memory diagnostics with bounded task/action/final evidence, record-version links and background delivery. Collection starts disabled and requires a separate client choice when offered.
- Sampled usefulness feedback from the active agent, including negative outcomes and improvement suggestions, with no separate model invocation or task continuation.

### Fixed
- Diagnostic delivery preserves uncertain queued evidence, recovers dead sender leases and isolates rejected events. Old revocations affect only their original collection generation.

## [0.3.65] - 2026-11-05

### Added
- One-command developer setup: `npx @pharaoh-so/mcp@latest install`, with the bare terminal command retained as an alias. Claude Code, Codex and supported Claude Desktop installations are checked independently, including desktop-only machines.
- An exact-version managed runtime that starts through an absolute Node executable, survives npm cache cleanup and repairs damaged installations. No separate local server command is needed.
- Eight portable Codex skills and one instruction consent for the effective global Claude Code and Codex instruction files. Desktop-only Claude Code can use personal skills when plugin registration is unavailable; plugin hooks remain inactive in that fallback.

### Fixed
- Codex setup no longer depends on Claude's absence or project-memory pilot eligibility.
- Installation preserves custom, disabled and project-specific registrations, reports each client outcome, and asks before migrating legacy pinned NPX connections.
- Failed authentication keeps usable credentials; failed runtime preparation leaves client settings unchanged. Ordinary logout removes managed registrations without resetting custom Claude connections.

## [0.3.64] - 2026-11-05

### Added
- Shell commands for the six question tools: `npx @pharaoh-so/mcp <tool> --repo <name> [flags]`. Answers go to stdout for pipes and files; `--json` returns the complete MCP result, and `<tool> --help` lists flags from the bundled schema.
- CLI exit codes distinguish tool or connection errors (1), usage errors (2), sign-in required (3), and tools outside the account's plan (4). Other refusals could return 0 when the MCP result had `isError: false`. Commands use stored credentials without running setup, and mask access and refresh tokens in output.

## [0.3.63] - 2026-11-05

### Fixed
- New calls wait briefly for the existing upstream reconnect to finish. Cancellation stays local to its request, and interrupted calls are never replayed.
- Pilot stale-evidence cues bind short repository requests to the map's ownership-validated full repository header, even when credential hints omit an organization.

## [0.3.62] - 2026-11-05

### Added
- `pharaoh_setup` in the tool list served before sign-in: what's set up for the repo you're in, and the first questions to ask Pharaoh.

### Changed
- Setup ends with one thing to ask: "Run the Pharaoh setup tool", in a new conversation in your repo, instead of three sample questions.
- The interactive setup's allow rules add `pharaoh_setup`, which is read-only.

## [0.3.61] - 2026-11-05

### Changed
- Eligible project memory pilot setup recommends quiet reminders and remembers declines through upgrades. The normal authenticated MCP connection provides memory when hooks are disabled or unavailable.

### Added
- Optional pilot worktree cues suggest graph tools for structural Bash searches and flag local edits that differ from a previously consulted codebase map revision.

## [0.3.60] - 2026-11-05

### Added
- When it connects, the proxy tells Pharaoh what your agent's instruction files say about it: whether `~/.claude/CLAUDE.md` holds the line setup suggests, mentions Pharaoh another way, doesn't, or is missing, and whether setup's block is still there. In Claude Code started at a git repo's root, the same for the project's `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` or `AGENTS.md`. Only those values are sent, never file text. A file over 64 KB, or one that isn't a regular file or can't be read, counts as unknown. Pharaoh uses this to learn whether the line leads agents to use it (privacy policy § 9, connection records).

## [0.3.59] - 2026-11-04

### Changed
- The project memory pilot uses Pharaoh's MCP tools by default. Interactive setup removes managed pilot hooks from user settings and from eligible ignored settings in the current checkout. Tracked or linked checkout hooks require manual removal.
- Use `--memory-hooks` during interactive setup to opt in to a prompt reminder for the MCP tools. Use `--disable-memory-hooks` to remove managed pilot hooks without signing in again.

## [0.3.58] - 2026-11-04

### Changed
- The ankh (☥) is gone: the Trace card's header has no mark, and the skills no longer set it as their emoji.

## [0.3.57] - 2026-11-04

### Changed
- Project memory uses compact recall by default. The agent can save one candidate during the task, and completion ends without a memory follow-up.

## [0.3.56] - 2026-11-04

### Fixed
- A connected project that is still mapping during normal setup now starts memory on an ordinary prompt after its mapped revision is verified.

## [0.3.55] - 2026-11-04

### Added
- Normal interactive setup and upgrades configure local project-memory hooks for accounts with an existing pilot grant. Codex uses its native hook review.

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
