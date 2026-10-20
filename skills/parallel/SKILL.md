---
name: parallel
prompt-name: parallel-agents
description: "Dispatch 2+ independent subagent tasks that run concurrently. Each agent gets focused scope, clear goal, constraints, and expected output. No shared state between agents. Review and integrate results after all complete."
version: 0.2.0
homepage: https://pharaoh.so
user-invocable: true
metadata: {"emoji": "☥", "tags": ["parallel", "subagents", "concurrency", "delegation", "efficiency"]}
---

# Parallel Dispatch

Delegate independent tasks to specialized agents running concurrently. Each agent gets isolated context and focused scope. Never share your session history — construct exactly what each agent needs.

## When to Use

- 2+ independent tasks with no shared state
- Multiple failures across different subsystems
- Each problem can be understood without context from others
- Agents won't edit the same files

## Do Not Use When

- Failures are related (fixing one might fix others)
- Tasks require understanding full system state
- Agents would edit the same files or resources
- You don't yet know what's broken (investigate first)

## The Pattern

### 1. Identify Independent Domains

Group work by what's independent:
- Different test files with different root causes
- Different modules with unrelated issues
- Different features with no shared code

### 2. Craft Agent Prompts

Each agent gets:

- **Specific scope:** one file, one module, one subsystem
- **Clear goal:** what success looks like
- **Constraints:** what NOT to change
- **Context:** error messages, relevant code paths, architectural notes
- **Expected output:** summary of findings and changes

### 3. Dispatch

Launch all agents simultaneously. They run concurrently with no coordination needed.

### 4. Review and Integrate

When agents return:

1. Read each summary — understand what changed
2. Check for conflicts — did agents edit overlapping code?
3. Run full test suite — verify all fixes work together
4. Spot-check results — agents can make systematic errors

## Prompt Quality

| Bad | Good |
|-----|------|
| "Fix all the tests" | "Fix the 3 failures in agent-abort.test.ts" |
| "Fix the race condition" | "Fix timing in abort test — here are the error messages: ..." |
| No constraints | "Do NOT change production code, fix tests only" |
| "Fix it" | "Return: root cause summary + what you changed" |

## Iron Rules

- **One task per agent** — focused agents produce better results than broad ones
- **No shared state** — agents must not depend on each other's output
- **Never trust agent reports** — verify changes independently before integrating
- **Construct context, don't inherit** — give each agent exactly what it needs, nothing more
