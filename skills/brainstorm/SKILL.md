---
name: brainstorm
prompt-name: brainstorm
description: "Explore intent, requirements, and design before implementation. Collaborative dialogue to turn ideas into specs. Ask clarifying questions one at a time, propose 2-3 approaches with trade-offs, get approval before writing any code. Prevents wasted work from unexamined assumptions."
version: 0.2.0
homepage: https://pharaoh.so
user-invocable: true
metadata: {"emoji": "☥", "tags": ["planning", "design", "brainstorming", "requirements", "architecture"]}
---

# Brainstorm

Turn ideas into validated designs before writing code. Every feature goes through this process — even "simple" ones. Simple projects are where unexamined assumptions waste the most time.

## When to Use

Before any creative work: new features, components, behavior changes, or significant modifications. If you're about to build something, brainstorm it first.

## Hard Gate

Do NOT write any implementation code until you have presented a design and the user has approved it. No exceptions regardless of perceived simplicity.

## Process

### 1. Explore Context

Check the current project state — files, docs, recent commits. If Pharaoh tools are available, call `get_codebase_map` to understand architecture before proposing changes.

### 2. Assess Scope

Before asking detailed questions, check if the request describes multiple independent subsystems. If so, decompose into sub-projects first. Each sub-project gets its own brainstorm-plan-implement cycle.

### 3. Ask Clarifying Questions

- One question per message — don't overwhelm
- Prefer multiple choice when possible
- Focus on: purpose, constraints, success criteria
- Keep going until you understand what you're building

### 4. Propose Approaches

- Present 2-3 different approaches with trade-offs
- Lead with your recommendation and explain why
- Apply YAGNI ruthlessly — remove unnecessary features

### 5. Present Design

- Scale each section to its complexity
- Cover: architecture, components, data flow, error handling, testing
- Ask after each section whether it looks right
- Design for isolation: smaller units with clear interfaces

### 6. Write Spec

Save the validated design to a spec file and commit it. Ask the user to review before proceeding.

### 7. Transition

Once the spec is approved, move to implementation. Use the `plan` skill to break the work into verified steps, then build.

## Working in Existing Codebases

- Explore current structure before proposing changes — follow existing patterns
- Use `get_module_context` to understand what exists
- Where existing code has problems affecting the work, include targeted improvements
- Don't propose unrelated refactoring — stay focused on the current goal

## Key Principles

- **One question at a time** — don't overwhelm with multiple questions
- **YAGNI ruthlessly** — remove unnecessary features from designs
- **Explore alternatives** — always propose 2-3 approaches before settling
- **Incremental validation** — present design, get approval before moving on
- **Design for isolation** — smaller units that can be understood and tested independently
