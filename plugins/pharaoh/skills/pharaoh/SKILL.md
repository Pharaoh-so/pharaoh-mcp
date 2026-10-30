---
name: pharaoh
description: "Which Pharaoh tool answers which structural question about a mapped repo (TypeScript, JavaScript, Python): where code lives, what calls it, what a change affects, what a module contains and what nothing runs."
---

Pharaoh maps codebases into queryable knowledge graphs — functions, dependencies, modules, connections. No source code stored.

## When to Use

Use when Pharaoh's tools are connected and the question is about the structure of a repo Pharaoh maps.

## Pick the tool by the question

| Question | Tool |
|---|---|
| Does X already exist? Where is Y implemented? | `search_functions` |
| What calls X? What breaks if I change it? Which endpoints or cron jobs reach it? | `get_blast_radius` |
| What's in this module, what does it depend on, who calls into it? | `get_module_context` |
| Is this code dead or wired in? What can I delete? | `get_unused_code` |
| How is the repo laid out? Which module owns this? What's the repo called? | `get_codebase_map` |
| Several of these at once (planning a change, reviewing a PR) | `pharaoh_recon` |

The graph reflects the default branch at its last mapped push, and a response says when a newer push is still being mapped. Grep and file reads cover what it leaves out: code that isn't on the default branch yet (other branches, uncommitted edits), literal text (strings, error messages, config values, comments, non-code files) and renames, which change every reference, tests and mocks included.

## Repos that aren't mapped

Repos are mapped through the Pharaoh GitHub App, installed on the account or org that owns them, and live repos re-map on every push. `pharaoh_account` shows each workspace's live repo and, where the App isn't installed, its install link. `search_functions` accepts any of the user's mapped repo names.

## Vision docs

**Vision docs are first-class.** If the repo has a `docs/VISION.md`, it's
the contract for what must always be true. Read it before touching
architecture. If a change would violate a MUST-bullet, stop and raise it
with the user before coding.

## Workflows

**PR review:** `pharaoh_recon` (map + touched modules + blast radius) → `get_blast_radius` on the riskiest changed functions. Verdict: SHIP, SHIP WITH CHANGES, or BLOCK. Any PR touching code governed by a MUST-bullet should reference the assertion in the review.

**VISION.md updates:** If a change affects an assertion in the repo's `docs/VISION.md`, point it out and offer to update the file.

## Utilities

- `pharaoh_account` — plan and live repo
- `pharaoh_manage_repo` — switch the live repo, or refresh a repo now

Full docs at [pharaoh.so/docs](https://pharaoh.so/docs).

## Connection

The plugin registers the Pharaoh connector. Run `/mcp`, select `pharaoh` and sign in with GitHub to connect it.
