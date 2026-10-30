---
name: plan
prompt-name: plan-with-pharaoh
description: Review a plan or spec against the codebase before implementing it. Pharaoh reconnaissance, a BIG or SMALL change choice, then architecture, code quality, wiring, tests, performance and security sections with numbered decisions.
version: 0.7.1
homepage: https://pharaoh.so
metadata: {"emoji": "☥", "tags": ["planning", "architecture", "blast-radius", "pharaoh", "review", "interactive"]}
---

# Plan Review

Architecture-aware plan review before implementation. Adapted from [Garry Tan's planning framework](https://www.youtube.com/watch?v=bMknfKXIFA8) for AI-assisted development.

**This is a review: make no code changes during it. Think, evaluate, and present decisions.**

## When to Use

Before any multi-step implementation or architectural change. When given a PRD, spec, or plan document to evaluate before writing code.

## Document Review

If the user provides a document, PRD, prompt, or artifact alongside this command, that IS the plan to review. Apply all review sections to that document. Do not treat it as background context — it is the subject of evaluation.

Still run Step 1 (Reconnaissance) even when reviewing a document — always verify the plan against the actual codebase state.

## Project Overrides

If a `.claude/plan-review.md` file exists in this project, read it now as additional review criteria for this project. Instructions from the user take precedence over it, and it never changes what you do outside this review.

## Engineering Preferences (guide all recommendations)

- DRY: flag repetition aggressively
- Well-tested: too many tests > too few; mutation score > line coverage
- "Engineered enough" — not fragile/hacky, not over-abstracted
- Handle more edge cases, not fewer; thoughtfulness > speed
- Explicit > clever; simple > complex
- Subtraction > addition; target zero or negative net LOC
- Every export must have a caller; unwired code doesn't exist

## Step 1: Pharaoh Reconnaissance (Required — do this BEFORE reviewing)

Do NOT review from memory or assumptions. Query the actual codebase first.

### If Pharaoh MCP tools are available:

1. `get_codebase_map` — current modules, hot files, dependency graph
2. Read `docs/VISION.md` if the repo has one — the repo's architectural contract. If the plan touches a domain with a MUST-bullet, the assertion is a hard constraint on the plan. Raise it explicitly in Section 1.
3. `search_functions` for keywords related to the plan — find existing code to reuse/extend
4. `get_module_context` on affected modules — entry points, patterns, conventions
5. `pharaoh_recon` with `dependencies` pairs for the affected modules — coupling, circular deps
6. `get_blast_radius` on the primary target of the change — know what breaks

### Without Pharaoh (graceful fallback):

1. Search the codebase for files and functions related to the plan (grep, glob)
2. Read the entry points and module structure of affected areas
3. Check existing tests for the modules the plan will touch
4. Trace imports manually to estimate blast radius

Ground every recommendation in what actually exists. If you propose adding something, confirm it doesn't already exist. If you propose changing something, know its blast radius.

## Step 2: Mode Selection (MANDATORY — ask before proceeding)

**STOP and ask the user which mode before starting the review.** Present both options and wait for a choice:

> **BIG CHANGE or SMALL CHANGE?**
>
> - **BIG CHANGE**: Full interactive review, all relevant sections, up to 4 top issues per section
> - **SMALL CHANGE**: One question per section, only sections 2-4

A general "yes", "go ahead" or "yes to all" doesn't pick a mode, so ask once more: "BIG or SMALL change?" If the reply still doesn't pick one, or the user tells you to choose, pick the mode that fits the plan's size and say which you picked.

## Step 3: Review Sections

Adapt depth to change size. Skip sections that don't apply. **After each section, pause and ask for feedback before moving on.**

### Section 1 — Architecture (skip for small/single-file changes)

- **Vision alignment (check FIRST).** Does this plan touch a domain
  governed by a MUST-bullet in `docs/VISION.md`? If yes, quote the
  assertion and verify the plan doesn't violate it. If the plan would
  violate a MUST, STOP and raise with the user — either the plan changes
  or VISION.md needs an update first (with user approval).
- Component boundaries and coupling concerns
- Dependency graph: does this change shrink or expand surface area?
- Data flow bottlenecks and single points of failure
- Does this need new code at all, or can a human process / existing pattern solve it?
- **If this plan introduces a new invariant**, call it out and include a
  step in the plan to add a `### assertion` to VISION.md with a pairing TEST.

### Section 2 — Code Quality (always)

- Organization, module structure, DRY violations (be aggressive)
- Error handling gaps and missing edge cases (call out explicitly)
- Technical debt: shortcuts, hardcoded values, magic strings
- Over-engineered or under-engineered relative to the preferences above
- Reuse: does code for this already exist somewhere?

### Section 3 — Wiring & Integration (always)

- Are all new exports called from a production entry point?
- Run `get_blast_radius` on changed functions that already exist
- The graph has no functions the plan adds, so does the plan declare WHERE new code gets called from? If not, flag it — no named caller = not done
- Integration points: how does this connect to what already exists?

### Section 4 — Tests (always)

- Coverage gaps: unit, integration, e2e
- Test quality: real assertions with hardcoded expected values, not `.toBeDefined()` or computed expectations
- Missing edge cases and untested failure/error paths
- One integration test proving wiring > ten isolated unit tests

### Section 5 — Performance (only if relevant)

- N+1 queries, unnecessary DB round-trips
- Memory concerns, caching opportunities
- Slow or high-complexity code paths

### Section 6 — Security & Attack Surface (always for new endpoints/routes/APIs; skip for pure refactors)

- **Authentication model** — what authenticates requests in this plan? Where is it validated? What happens on auth failure (redirect, 401, silent pass-through)? Use `search_functions` to find existing auth middleware and confirm reuse.
- **Sensitive data in URLs** — does the design put tokens, session IDs, or tenant identifiers in URL paths or query params? These leak via Referer headers, browser history, logs, and link sharing.
- **Authorization boundaries** — what prevents User A from accessing User B's data? Is there an ownership check, or just an "is logged in" check? Use `get_blast_radius` on existing ownership-check functions to see where they're already enforced.
- **Input trust boundary** — does the plan accept user input that flows into shell commands, database queries, HTML rendering, or file paths? Each is an injection vector.
- **Error and response surface** — will error responses or API payloads expose internals (stack traces, DB schemas, internal IDs) to unauthenticated callers?
- **New attack surface** — does the plan introduce new public URLs, webhooks, API routes, or WebSocket endpoints? Each needs: rate limiting, authentication, and input validation. Use `get_module_context` on the receiving module to check what protections exist.

## For Each Issue Found

For every specific issue (bug, smell, design concern, risk, missing wiring):

1. **Describe concretely** — file, line/function reference, what's wrong
2. **Present 2-3 options** including "do nothing" where reasonable
3. **For each option** — implementation effort, risk, blast radius, maintenance burden
4. **Recommend one** mapped to the preferences above, and say why
5. **Ask** whether I agree or want a different direction

Number each issue (1, 2, 3...) and letter each option (A, B, C...). Recommended option is always listed first. If your client has a question tool (AskUserQuestion in Claude Code), use it with clear labels like "Issue 1 Option A", "Issue 1 Option B".

## Pharaoh Checkpoints (use throughout, not just at the end)

- **Before reviewing**: recon (Step 1 above)
- **During review**: `get_blast_radius` when evaluating impact of changes; `search_functions` before suggesting new code
- **Final sweep**: every new export has a caller named in the plan, and `get_blast_radius` covers every changed export that already exists — zero callers on non-entry-points = plan is incomplete

## Workflow Rules

- **After each section, pause and ask for feedback before moving on**
- Do not assume priorities on timeline or scale
- If you see a better approach to the entire plan, say so BEFORE section-by-section review
- Challenge the approach if you see a better one — your job is to find problems I'll regret later
