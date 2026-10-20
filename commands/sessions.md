---
description: Decompose work into parallel, isolated sessions using git worktrees
---

# Session Decomposition

Break large tasks into parallel, isolated work sessions. Each session runs in its own git worktree with fresh context, focused scope, and atomic commits.

## When to Use

- Task is too large for a single context window
- Work has 3+ independent sub-tasks that don't touch the same files
- You need to preserve context quality across a multi-hour effort
- Multiple features or fixes can proceed in parallel

## Do Not Use When

- Sub-tasks share files or state
- Work is sequential (each step depends on the previous)
- Task fits comfortably in one session

## Step 1: Reconnaissance

If Pharaoh MCP tools are available, call `get_codebase_map` and `get_module_context` on affected modules to understand the current landscape before decomposing.

## Step 2: Decompose

Break the task into sessions. Each session must:

- Have a clear, narrow goal (one feature, one fix, one module)
- Touch a distinct set of files — no overlap between sessions
- Be independently verifiable (tests pass, build succeeds)
- Produce atomic commits that make sense on their own

## Step 3: Write Session Prompts

For each session, write a complete prompt containing:

- **Goal:** what this session produces (1-2 sentences)
- **Scope:** which files/modules to touch (explicit list)
- **Constraints:** what NOT to change
- **Verification:** how to confirm the work is correct
- **Context:** any architectural decisions or patterns to follow

## Step 4: Present for Review (MANDATORY — do NOT skip)

**STOP. Paste every session prompt into the chat as a numbered list.**

For each session, show:
1. The session name
2. The full prompt text
3. Which sessions need `/plan` review (flag anything non-trivial)

**Wait for the user to approve, modify, add, remove, or reorder sessions before proceeding.** Do not create worktrees or execute any work until the user explicitly approves the decomposition.

If the user says "looks good" or similar, proceed. If they request changes, update the prompts and present again.

## Step 5: Create Worktrees

Only after user approval. For each session, create an isolated worktree:

```bash
git worktree add .worktrees/<session-name> -b <branch-name>
```

Install dependencies in each worktree. Verify clean baseline (tests pass).

## Step 6: Execute Sessions

Run each session independently. Sessions should not reference each other's work-in-progress — they operate on the same base commit.

## Step 7: Integrate

After all sessions complete:

1. Verify each branch independently (tests pass, build succeeds)
2. Merge branches sequentially into the target branch
3. Resolve any conflicts (rare if decomposition was clean)
4. Run full verification on the integrated result

## Decomposition Rules

| Good decomposition | Bad decomposition |
|---|---|
| Session A: auth module, Session B: billing module | Session A: backend, Session B: frontend (likely share types) |
| Session A: new feature, Session B: unrelated bugfix | Session A: write code, Session B: write tests (coupled) |
| Session A: parser, Session B: renderer (clear interface) | Session A: first half of file, Session B: second half |

## Key Principles

- **No shared files** — if two sessions touch the same file, merge them into one
- **Fresh context per session** — don't carry state between sessions
- **Atomic commits** — each session's output should be a coherent, reviewable unit
- **Verify before integrating** — never merge a session that doesn't pass its own checks
- **Decomposition is the hard part** — spend time getting boundaries right before starting work
- **The user reviews before execution** — always present prompts, never skip to building
---

Here is the task to decompose into sessions:

$ARGUMENTS
