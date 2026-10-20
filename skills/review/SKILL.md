---
name: review
prompt-name: review-with-pharaoh
description: "The definitive code review, for any codebase. Five-phase workflow: git context detection (worktree, branch, base, changed files), Pharaoh recon (architecture map, module context, blast radius in one call, with a fallback when the repo isn't mapped), parallel specialized agent dispatch (code quality, security against the project's own rules, error handling, test coverage, type design), adversarial review for security-sensitive changes, and a final synthesized verdict of SHIP / SHIP WITH CHANGES / BLOCK. Architecture-aware wherever Pharaoh maps the repo, always branch-aware."
version: 0.4.2
homepage: https://pharaoh.so
user-invocable: true
metadata: {"emoji": "☥", "tags": ["code-review", "pull-request", "architecture", "pharaoh", "multi-agent", "adversarial-review", "regression-risk", "spec-alignment"]}
---

# Review with Pharaoh

The definitive code review, for any codebase. Architecture-aware, branch-aware, multi-agent, adversarial. Five phases that combine Pharaoh's knowledge graph with parallel specialized reviewers and an independent second opinion. Every phase works without Pharaoh too; Pharaoh makes the architecture picture exact and cheap where it maps the repo.

Final verdict: **SHIP** / **SHIP WITH CHANGES** / **BLOCK**

## When to Use

Before merging any branch. Before opening any PR. When reviewing changes that touch shared modules, export new functions, modify core data flows, or claim to implement a spec.

---

## Phase 0 — Git Context

**Goal:** Know exactly what changed and where you are. This phase is mandatory and runs before anything else.

1. Detect the current environment:
   ```bash
   git rev-parse --show-toplevel          # repo root (may be a worktree)
   git worktree list                      # detect if running in a worktree
   git branch --show-current              # current branch name
   git log --oneline -1                   # latest commit
   ```

2. Determine the base (where this branch diverged from the branch it merges into). The target is the first of these that resolves:
   ```bash
   TARGET=$(gh pr view --json baseRefName --jq '"origin/" + .baseRefName' 2>/dev/null)   # the open PR's target branch
   [ -n "$TARGET" ] || TARGET=$(git symbolic-ref -q --short refs/remotes/origin/HEAD)    # the default branch, set by git clone
   [ -n "$TARGET" ] || for b in origin/main origin/master main master; do
     git rev-parse -q --verify "$b" >/dev/null && TARGET=$b && break
   done
   BASE=$(git merge-base HEAD "$TARGET") && echo "base: $BASE"
   ```
   If no base comes out, stop and ask which branch this merges into. An empty base makes every diff below come out empty, and the review would report no changes. If your shell doesn't keep variables between commands, set `BASE` to the printed commit at the start of each one.

3. Collect the full changeset from the base:
   ```bash
   : "${BASE:?no base: ask which branch this merges into}"   # stops here rather than diff HEAD against itself
   git diff --name-only "$BASE"...HEAD   # all changed files
   git diff --stat "$BASE"...HEAD        # summary stats
   git log --oneline "$BASE"..HEAD       # all commits on this branch
   ```

4. Also check for uncommitted work:
   ```bash
   git diff --name-only                   # unstaged changes
   git diff --cached --name-only          # staged but uncommitted
   ```

5. Extract the **touched modules** from the changed file paths. Group files by their top-level directory or module boundary. These module names feed Phase 1.

**Output of Phase 0:** Branch name, base branch, commit count, list of changed files, list of touched modules, and whether there's uncommitted work.

---

## Phase 1 — Pharaoh Recon

**Goal:** Get the full architectural picture, and the project's own rules, before reading the diff in depth. Do NOT skip this phase: it is what makes this review architecture-aware instead of just a code diff review.

### With Pharaoh

Call `pharaoh_recon` with:
- **repo:** The repository name (if the name is wrong, Pharaoh replies with the repos it maps)
- **include_map:** `true`
- **modules:** The touched modules from Phase 0 (up to 5)
- **blast_radius:** The most critical changed files/functions as blast radius targets (up to 3). Pick the files with the most downstream risk — entry points, shared utilities, exported APIs.
- **dependencies:** Pairs of touched modules to trace coupling between (up to 3)

Pharaoh's graph maps the default branch, so it shows what the change lands on: callers, blast radius, module boundaries, endpoints. Code that is new on this branch isn't in it yet; read the diff for that.

### Without Pharaoh (graceful fallback)

If Pharaoh isn't connected, or doesn't map this repo, build the same picture by hand. When Pharaoh is connected but doesn't map the repo, tell the user once that mapping it makes this review architecture-aware, with the install link from `pharaoh_account`, then carry on:
1. Read the top-level layout and the manifest files (package.json, pyproject.toml, go.mod, Cargo.toml) to find the module boundaries
2. For each changed exported function or file, search for its callers to estimate the blast radius
3. Read the entry points the change can reach: routes, CLI commands, jobs, event handlers
4. Say in the review that the architecture context came from search, not the graph

### The project's own rules

Read the rules the project states for itself: `CLAUDE.md` or `AGENTS.md` (including nested ones in touched directories), `CONTRIBUTING.md` and `SECURITY.md`, whichever exist. Note every rule stated as non-negotiable: testing requirements, security invariants, code style. They are what Phase 2's reviewers check the change against.

Then read `docs/VISION.md` if the repo has one — the repo's architectural contract. For every touched module, find its relevant assertions. Any change touching code governed by a MUST-bullet must be checked against that assertion — if the change would violate the MUST, the verdict tips toward BLOCK unless VISION.md is updated in the same PR with user approval.

**Output of Phase 1:** Architecture map, module profiles for every touched module, blast radius for high-risk changes, dependency paths between coupled modules, the project's rules, and spec alignment.

---

## Phase 2 — Parallel Specialized Review

**Goal:** Deep-dive the actual code changes from multiple expert angles simultaneously. Launch these as **parallel subagents** — they are independent and should run concurrently.

### Determine which reviewers to dispatch

| Agent | When to dispatch | Focus |
|-------|-----------------|-------|
| **Code Reviewer** | Always | Bugs, logic errors, compliance with the project's rules, code quality. Confidence-filtered (only issues >= 80/100). |
| **Security Reviewer** | When changes touch any security-sensitive surface (see the detection triggers below). Also dispatch when the Phase 1 blast radius marks the change as HIGH risk. | OWASP Top 10, injection vectors, access control bypasses, tenant isolation in multi-tenant systems, cryptographic misuse, secret exposure, plus the project's own security rules. See checklist below. |
| **Silent Failure Hunter** | When changes touch error handling, catch blocks, fallback logic, API calls, or any code that could suppress errors | Silent failures, broad catches, swallowed errors, missing user feedback, unjustified fallbacks. |
| **Test Analyzer** | When test files are changed, or when new functionality lacks corresponding tests | Behavioral coverage gaps, brittle tests, missing edge cases, tests that prove nothing. |
| **Type Design Analyzer** | When new types/interfaces are introduced or existing types are modified | Encapsulation, invariant expression, invariant enforcement. Rates each type 1-10 on four axes. |

### Security Reviewer — Checklist

The Security Reviewer agent runs a systematic audit against two layers: universal web security (OWASP) and project-specific invariants.

**Layer 1 — OWASP Top 10 + Common Vulnerabilities:**
- **Injection:** SQL, NoSQL and graph query injection, command injection, XSS (reflected/stored/DOM), template injection
- **Broken auth:** Hardcoded credentials, weak token generation, missing expiry, session fixation
- **Broken access control:** Missing authorization checks, IDOR, privilege escalation, path traversal
- **Cryptographic failures:** Weak algorithms, plaintext secrets, missing encryption at rest/transit, key exposure
- **Security misconfiguration:** Permissive CORS, verbose error messages leaking internals, debug endpoints in production
- **Vulnerable dependencies:** Known CVEs in direct dependencies (check against changed package.json/lockfile)
- **SSRF:** Unvalidated URLs in fetch/request calls, redirect chains
- **Logging & monitoring:** Sensitive data in logs, missing audit trails for privileged operations

**Layer 2 — The project's own security rules:**
Take them from the project's rules collected in Phase 1 and check each one against the diff by name. Rules like "every query is scoped to the caller's tenant", "tokens are stored hashed" and "webhooks verify their signature" are what this layer exists for. If the project states none, work out its threat model from the code: who the users and tenants are, where secrets live, which inputs are untrusted.

**Detection triggers (dispatch when the change touches any of these):**
- Authentication, sessions, tokens, permissions, and the middleware that guards routes
- Cryptography, secrets, key handling, and environment variables that hold credentials
- Query construction and data access (SQL, raw ORM queries, NoSQL, graph queries), schema migrations
- Payments, billing, subscriptions
- Webhooks, signature verification, third-party callbacks
- File paths, uploads, shell commands or URLs built from user input
- Anything the project's rules call security-sensitive

Always match on file paths and names (auth, session, token, crypto, middleware, webhook, billing, payment, migration), and classify files that are new on this branch from the diff itself. With Pharaoh, also find these structurally: `get_module_context` on a touched module lists its endpoints, database tables and environment variables, and `get_blast_radius` shows the endpoints, jobs and database operations a changed function reaches. A change that reaches an endpoint, a table or a secret is security-sensitive. Pharaoh's graph is the default branch, so it sees what existing code a change reaches, never the files the branch adds.

**Output format:** Each finding must include:
1. Vulnerability class (e.g., "SQL Injection", "Missing Authorization Check")
2. Severity: CRITICAL / HIGH / MEDIUM
3. Affected file:line
4. Attack scenario: how an attacker would exploit this
5. Remediation: specific code change required

### How to dispatch each agent

For each agent, launch a subagent (via the Agent tool) with:
1. The **git diff** of the relevant changed files (not the full session history)
2. The **architecture context** from Phase 1 (architecture map, blast radius, module profiles, from Pharaoh or the fallback) — this is what makes these agents architecture-aware
3. The **project's rules** from Phase 1 that bear on the review (testing requirements, security rules, code style)
4. A clear instruction to focus ONLY on changed code, not pre-existing issues
5. For the **Security Reviewer** specifically: the project's security rules (Layer 2) and the security-sensitive files you found, so it knows the project's threat model

Each agent returns a structured report with findings categorized by severity:
- **CRITICAL** (90-100): Must fix before merge
- **IMPORTANT** (80-89): Should fix before merge
- **SUGGESTION** (70-79): Consider for a follow-up

### What NOT to dispatch

- **Comment Analyzer** and **Code Simplifier** are polish agents. Do not include them in the review — they distract from correctness. Run them separately if wanted.
- Do not dispatch agents for trivial changes (typo fixes, dependency bumps, config changes). If Phase 0 shows < 20 lines changed across non-test files, skip Phase 2 entirely and go straight to Phase 4.

---

## Phase 3 — Adversarial Review

**Goal:** Independent second opinion on security-sensitive changes. A different agent evaluates the code fresh, without knowledge of your reasoning.

### When to trigger

Trigger Phase 3 when ANY of these are true:
- Changes touch **auth, encryption, access control, token handling, or session management**
- Changes touch **multi-tenant isolation, query construction, or data access patterns**
- Changes touch **billing, subscription management, or payment flows**
- Changes modify **webhook verification or signature checking**
- The Phase 1 blast radius marks the change as **HIGH** risk
- You are not confident about a specific change's correctness

If none of these triggers are met, **skip Phase 3** and proceed to Phase 4.

### How to run

1. **Prepare a review package** — do NOT send your session history:
   - The changed files (full diff or complete file contents)
   - What the code does and why it was changed (1-2 sentences)
   - The project's security rules from Phase 1 (tenant isolation, encryption requirements, etc.)
   - Specific concerns you want the reviewer to focus on

2. **Dispatch to an independent subagent** with instructions to evaluate the code fresh and assign verdicts:

   | Verdict | Meaning |
   |---------|---------|
   | **AGREE** | Implementation is correct for the stated concern |
   | **DISAGREE** | Concrete issue identified with evidence and suggested fix |
   | **CONTEXT** | Cannot determine correctness — needs more information |

3. **Evaluate findings:**
   - AGREE items: no action
   - DISAGREE items: verify against actual code. If confirmed, it becomes a CRITICAL finding. If the reviewer lacked context, document why the current approach is correct.
   - CONTEXT items: provide the missing information and note it in the review output

---

## Phase 4 — Synthesis & Verdict

**Goal:** Merge all findings into a single, actionable review. No raw dumps — synthesize.

### Structure the output as:

```markdown
# Review: [branch-name] → [base-branch]

**[X] commits | [Y] files changed | [Z] modules touched**
**Worktree:** [path] (or "main repo")

---

## Architecture Impact
- Modules affected: [list with blast radius numbers]
- Dependency changes: [new coupling, removed coupling]
- Highest blast radius: [module/function] → [N downstream callers across M modules]

## Risk Assessment
- Regression risk: [LOW / MEDIUM / HIGH] — [one-line reason]
- Volatile modules touched: [list, if any]
- Wiring status: [all new exports reachable? / N unreachable exports found]

## Code Quality ([N] findings)

### Critical ([count])
- [finding with file:line, source agent, and fix]

### Important ([count])
- [finding with file:line, source agent, and fix]

### Suggestions ([count])
- [finding with file:line]

## Security ([N] findings, or "No security-sensitive changes")
- [Security reviewer findings with vulnerability class, severity, file:line, attack scenario, and remediation]
- [Or: "Security reviewer not dispatched — no security-sensitive files in changeset"]

## Test Coverage
- [Test analyzer summary — gaps, quality issues, positive observations]

## Spec Alignment
- [Vision gaps introduced or resolved]

## Adversarial Review
- [Phase 3 results, or "Skipped — no security-sensitive changes detected"]

---

## Verdict: [SHIP / SHIP WITH CHANGES / BLOCK]

[If not SHIP: numbered list of specific required changes before merge]
```

### Auto-block triggers (any of these = BLOCK)

- Any CRITICAL security finding (injection, broken access control, tenant isolation violation, secret exposure)
- Unreachable exports in an application (new public code that nothing calls). In a library, exports are the public API: check each new one is documented or tested instead. Without graph reachability data, a search can't prove nothing calls it: raise it under SHIP WITH CHANGES, not BLOCK
- New circular dependencies between modules
- HIGH regression risk without corresponding test coverage
- **A MUST-bullet in `docs/VISION.md` is violated by this change** (without VISION.md being updated in the same PR with user approval)
- Vision spec drift: new complex function has no matching assertion AND the domain it lives in has existing assertions (implies invariants are expected here)
- Any CRITICAL finding from Phase 2 or Phase 3 that is confirmed and unfixed
- DISAGREE verdict from adversarial review on security-sensitive code, confirmed after verification
- A violation of a security rule the project states as non-negotiable (Phase 1), such as a query that skips the project's tenant scoping or a handler that skips its authorization check

### SHIP WITH CHANGES triggers

- IMPORTANT findings that are confirmed but non-blocking
- Test coverage gaps for new functionality
- Duplication that should be consolidated in a follow-up
- Spec drift that is intentional but should be documented

### SHIP triggers

- No CRITICAL or confirmed IMPORTANT findings
- All new exports are reachable (applications) or documented or tested (libraries)
- Regression risk is LOW or MEDIUM with adequate test coverage
- Spec alignment is clean or intentionally divergent with documentation

---

## Quick Mode

For small changes (< 50 lines, single module, no security surface):
- Run Phase 0 + Phase 1 + Phase 4 only
- Skip Phase 2 (parallel agents) and Phase 3 (adversarial)
- Still architecture-aware, just faster

Explicitly opt in with: `/review quick`
