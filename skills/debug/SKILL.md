---
name: debug
prompt-name: systematic-debugging
description: "Systematic 4-phase debugging methodology. Root cause investigation before any fixes. Read errors carefully, reproduce consistently, trace data flow, form hypotheses, test minimally. If 3+ fixes fail, question the architecture. No guessing, no quick patches, no symptom fixes."
version: 0.2.0
homepage: https://pharaoh.so
user-invocable: true
metadata: {"emoji": "☥", "tags": ["debugging", "root-cause", "investigation", "troubleshooting", "methodology"]}
---

# Systematic Debugging

Find root cause before attempting fixes. Random fixes waste time and create new bugs.

**If you haven't completed Phase 1, you cannot propose fixes.**

## When to Use

Any technical issue: test failures, bugs, unexpected behavior, performance problems, build failures, integration issues. Use this **especially** under time pressure — systematic is faster than thrashing.

## The Four Phases

### Phase 1: Root Cause Investigation

**Before attempting ANY fix:**

1. **Read error messages carefully** — don't skip past them. Read stack traces completely. Note line numbers, file paths, error codes.
2. **Reproduce consistently** — can you trigger it reliably? What are the exact steps? If not reproducible, gather more data — don't guess.
3. **Check recent changes** — git diff, recent commits, new dependencies, config changes, environmental differences.
4. **Trace data flow** — where does the bad value originate? What called this with the bad value? Keep tracing backward until you find the source. Fix at source, not symptom.

If Pharaoh tools are available, use `get_blast_radius` to understand what the buggy code affects.

### Phase 2: Pattern Analysis

1. **Find working examples** — locate similar working code in the same codebase
2. **Compare against references** — if implementing a pattern, read the reference completely
3. **Identify differences** — list every difference between working and broken, however small
4. **Understand dependencies** — what components, config, environment does this need?

### Phase 3: Hypothesis and Testing

1. **Form a single hypothesis** — "I think X is the root cause because Y"
2. **Test minimally** — smallest possible change, one variable at a time
3. **Verify** — did it work? Yes: proceed to Phase 4. No: form a new hypothesis. Don't stack fixes.

### Phase 4: Implementation

1. **Create a failing test** that reproduces the issue
2. **Implement a single fix** addressing root cause — one change, no "while I'm here" improvements
3. **Verify** — test passes, no other tests broken, issue actually resolved
4. **If 3+ fixes have failed: STOP.** Question the architecture. Each fix revealing new problems in different places means this is an architectural issue, not a bug. Discuss with the user before attempting more fixes.

## Red Flags — Return to Phase 1

- "Quick fix for now, investigate later"
- "Just try changing X and see"
- "I don't fully understand but this might work"
- Proposing solutions before tracing data flow
- "One more fix attempt" after 2+ failures
- Each fix reveals a new problem in a different place

## Quick Reference

| Phase | Goal | Done when |
|-------|------|-----------|
| 1. Root Cause | Understand WHAT and WHY | Can explain the bug to someone else |
| 2. Pattern | Find working reference | Know what's different |
| 3. Hypothesis | Confirm theory | Smallest change proves or disproves |
| 4. Implementation | Fix with test | Bug resolved, tests pass, no regressions |
