---
name: verify
prompt-name: verification
description: "Evidence before assertions. Run verification commands and confirm output before claiming work is complete, fixed, or passing. No 'should work now' — run the command, read the output, then claim the result. Covers tests, builds, linting, agent delegation, and requirement checklists."
channels: npx
license: MIT. Adapted from obra/superpowers, Copyright (c) 2025 Jesse Vincent; see NOTICE in @pharaoh-so/mcp
version: 0.2.1
homepage: https://pharaoh.so
user-invocable: true
metadata: {"emoji": "☥", "tags": ["verification", "quality", "completion", "evidence", "discipline"]}
---

# Verification Before Completion

Claiming work is complete without verification is dishonesty, not efficiency.

**Evidence before claims, always.**

## When to Use

Before ANY claim of success, completion, or correctness. Before committing, creating PRs, moving to next task, or delegating to agents. Applies to every positive statement about work state.

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate

1. **IDENTIFY:** what command proves this claim?
2. **RUN:** execute the full command (fresh, in this message)
3. **READ:** full output — check exit code, count failures
4. **VERIFY:** does output confirm the claim?
5. **ONLY THEN:** make the claim

Skip any step and the claim is unverified.

## What Counts as Evidence

| Claim | Requires | NOT sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing |
| Bug fixed | Reproduce original symptom: gone | Code changed, assumed fixed |
| Agent completed | Diff shows correct changes | Agent reports "success" |
| Requirements met | Line-by-line checklist verified | Tests passing |

If Pharaoh tools are available, use `get_blast_radius` on changed functions to confirm every caller is accounted for.

## Red Flags — Stop

- Using "should", "probably", "seems to"
- Expressing satisfaction before running verification
- About to commit without fresh test/build/lint output
- Trusting agent success reports without checking
- "Just this once" thinking
- Relying on partial verification

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | Run the command. |
| "I'm confident" | Confidence is not evidence. |
| "Linter passed" | Linter is not the compiler. |
| "Agent said success" | Verify independently. |
| "Partial check is enough" | Partial proves nothing. |

## The Bottom Line

Run the command. Read the output. Then claim the result. No shortcuts.
