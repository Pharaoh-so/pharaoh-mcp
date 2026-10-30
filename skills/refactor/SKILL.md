---
name: refactor
prompt-name: safe-refactor
description: "Safe refactoring workflow using Pharaoh codebase knowledge graph. Six-step process: module context, blast radius of downstream callers, reachability verification, dependency mapping, naming conflict detection, and test coverage assessment. Produces a refactoring plan with every caller listed, test files identified, unreachable code flagged, and high-risk paths warned."
version: 0.3.0
homepage: https://pharaoh.so
user-invocable: true
metadata: {"emoji": "☥", "tags": ["refactoring", "blast-radius", "architecture", "pharaoh", "safe-refactor", "test-coverage"]}
---

# Safe Refactor

Step-by-step workflow to safely refactor a function or module with full blast radius awareness. Six steps map every caller, find the affected tests, flag unreachable code, and warn about high-risk downstream paths before a single line changes.

## When to Use

Invoke before refactoring any function, module, or file — especially shared utilities, exports used across multiple modules, or anything with an unclear caller graph. Use it whenever the blast radius of a change is unknown.

## Workflow

1. **Module context:** call `get_module_context` for the module containing the target to understand its current structure.
2. **Blast radius:** call `get_blast_radius` for the target to identify all downstream callers and affected modules.
3. **Reachability:** call `get_unused_code` with `module` set to the target's module to find dead code the refactor can delete. When the target is a function, also call it with `functions` set to the target to confirm an entry point reaches it.
4. **Dependencies:** call `pharaoh_recon` with `include_map` false and `dependencies` pairs between the target's module and the modules its callers live in, to see the coupling the refactor has to keep or break.
5. **Naming conflicts:** call `search_functions` to check if the refactored version's name already exists elsewhere.
6. **Test coverage:** search the test files for the target's name. `get_blast_radius` leaves out test-file callers, so this is how you find the tests to change.

Do not propose a refactoring plan until all 6 steps are complete.

## Output

A refactoring plan containing:
- **Callers to update:** every function and file that calls the target, with update requirements
- **Tests to change:** test files covering the refactored code, with required modifications
- **Dead code:** unreachable code paths that can be deleted during the refactor
- **High-risk paths:** downstream modules with wide blast radius or high complexity scores
- **Naming conflicts:** existing functions whose names would conflict with the refactored version
