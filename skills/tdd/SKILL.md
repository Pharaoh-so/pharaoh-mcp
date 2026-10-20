---
name: tdd
prompt-name: test-driven-development
description: "Test-driven development discipline. Write the failing test first, watch it fail, write minimal code to pass, refactor. No production code without a failing test. No exceptions without explicit permission. Covers red-green-refactor cycle, common rationalizations, and when to start over."
version: 0.2.0
homepage: https://pharaoh.so
user-invocable: true
metadata: {"emoji": "☥", "tags": ["tdd", "testing", "red-green-refactor", "quality", "discipline"]}
---

# Test-Driven Development

Write the test first. Watch it fail. Write minimal code to pass. Refactor.

**If you didn't watch the test fail, you don't know if it tests the right thing.**

## When to Use

Always — for new features, bug fixes, refactoring, and behavior changes. Exceptions require explicit user permission (throwaway prototypes, generated code, config files).

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Wrote code before the test? Delete it. Start over. Don't keep it as "reference." Don't adapt it. Delete means delete.

## Red-Green-Refactor

### RED — Write Failing Test

Write one minimal test showing what should happen.

- One behavior per test
- Clear name describing the behavior
- Real code, not mocks (unless unavoidable)

Run the test. Confirm it **fails** (not errors) for the expected reason — the feature is missing, not a typo.

### GREEN — Minimal Code

Write the simplest code that makes the test pass. Nothing more.

- Don't add features the test doesn't require
- Don't refactor other code
- Don't "improve" beyond the test

Run the test. Confirm it passes. Confirm other tests still pass.

### REFACTOR — Clean Up

Only after green:
- Remove duplication
- Improve names
- Extract helpers

Keep tests green throughout. Don't add behavior during refactor.

### Repeat

Next failing test for next behavior.

## Bug Fix Flow

1. Write a failing test that reproduces the bug
2. Watch it fail — confirms the test catches the bug
3. Fix the bug with minimal code
4. Watch it pass — confirms the fix works
5. Refactor if needed

Never fix bugs without a regression test.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Need to explore first" | Fine. Throw away exploration, then start with TDD. |
| "Test hard = skip test" | Hard to test = hard to use. Simplify the interface. |
| "TDD will slow me down" | TDD is faster than debugging. Always. |
| "Already manually tested" | Ad-hoc is not systematic. No record, can't re-run. |

## Red Flags — Start Over

- Code written before test
- Test passes immediately (testing existing behavior)
- Can't explain why test failed
- "Just this once" rationalization
- Keeping pre-TDD code "as reference"

**All of these mean: delete code, start over with TDD.**

## Verification Checklist

Before marking work complete:

- Every new function has a test
- Watched each test fail before implementing
- Each test failed for the expected reason
- Wrote minimal code to pass each test
- All tests pass with clean output
- Tests use real code (mocks only if unavoidable)
- Edge cases and errors are covered
