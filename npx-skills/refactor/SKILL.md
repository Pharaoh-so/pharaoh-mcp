---
name: refactor
prompt-name: safe-refactor
description: "Safe refactoring workflow using Pharaoh codebase knowledge graph. Six-step process: module context, blast radius of detected downstream callers, reachability verification, dependency mapping, naming conflict detection, and a search for the affected tests. Produces a refactoring plan with detected callers listed, test files identified, unreachable code flagged, and high-risk paths warned. Use when refactoring, renaming, moving or splitting code in a repo Pharaoh maps, with Pharaoh's tools connected."
version: 0.3.1
homepage: https://pharaoh.so
metadata: {"emoji": "☥", "tags": ["refactoring", "blast-radius", "architecture", "pharaoh", "safe-refactor", "test-coverage"]}
---

# Safe Refactor

Step-by-step workflow to safely refactor a function or module with full blast radius awareness. Six steps map the detected callers, find the affected tests, flag unreachable code, and warn about high-risk downstream paths before a single line changes.

## When to Use

Invoke before refactoring a function, module, or file in a repo Pharaoh maps — especially shared utilities, exports used across multiple modules, or anything with an unclear caller graph. Use it whenever the blast radius of a change is unknown.

**Stop rule:** if Pharaoh's tools aren't connected, or they report that this repo isn't mapped, stop and tell the user. Steps 1-5 read the graph and have no fallback.

## Workflow

1. **Module context:** call `get_module_context` for the module containing the target to understand its current structure.
2. **Blast radius:** call `get_blast_radius` for the target to identify its detected downstream callers and affected modules.
3. **Reachability:** call `get_unused_code` with `module` set to the target's module to find dead code the refactor can delete. When the target is a function, also call it with `functions` set to the target to confirm an entry point reaches it.
4. **Dependencies:** call `pharaoh_recon` with `include_map` false and `dependencies` pairs between the target's module and the modules its callers live in, to see the coupling the refactor has to keep or break.
5. **Naming conflicts:** call `search_functions` to check if the refactored version's name already exists elsewhere.
6. **Test coverage:** search the test files for the target's name. `get_blast_radius` leaves out test-file callers, so this is how you find the tests to change. If you can't read the repo's files, say so and list the tests as unknown.

Do not propose a refactoring plan until all 6 steps are complete.

## Output

A refactoring plan containing:
- **Callers to update:** the detected functions and files that call the target, with update requirements. Dynamic behavior and framework configuration can leave gaps, so say the list may be incomplete
- **Tests to change:** test files covering the refactored code, with required modifications
- **Dead code:** what `get_unused_code` calls Dead can be deleted during the refactor; check anything Possibly unused before deleting it
- **High-risk paths:** downstream modules with wide blast radius or high complexity scores
- **Naming conflicts:** existing functions whose names would conflict with the refactored version
