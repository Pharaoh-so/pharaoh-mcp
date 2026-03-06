# Pharaoh

**Codebase intelligence for AI agents. Your AI understands your architecture before it writes a single line.**

[![Pharaoh MCP server](https://glama.ai/mcp/servers/Pharaoh-so/pharaoh-mcp/badge)](https://glama.ai/mcp/servers/Pharaoh-so/pharaoh-mcp)

[pharaoh.so](https://pharaoh.so)

---

## Quick Start (60 seconds)

### Claude Code

```bash
claude mcp add pharaoh --transport sse https://mcp.pharaoh.so/sse
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pharaoh": {
      "url": "https://mcp.pharaoh.so/sse"
    }
  }
}
```

### Generic MCP Client

```json
{
  "mcpServers": {
    "pharaoh": {
      "transport": "sse",
      "url": "https://mcp.pharaoh.so/sse"
    }
  }
}
```

### Setup

1. Add the MCP URL to your client (see above)
2. Authorize via OAuth — you'll be prompted to install the Pharaoh GitHub App on your org
3. Repos are mapped automatically. Start querying.

---

## What Pharaoh Does

Pharaoh parses your repositories using tree-sitter into a Neo4j knowledge graph — functions, modules, imports, exports, call chains, endpoints, complexity scores, all mapped as nodes and edges. AI agents query the graph via MCP for structured architectural context instead of reading files one at a time. Deterministic analysis — no LLM in the pipeline, zero hallucination risk.

---

## Tools

| Tool | What it does | Tier |
|------|-------------|------|
| `get_codebase_map` | Full structural overview — modules, dependency graph, entry points, hot files | Free |
| `get_module_context` | Complete module profile — functions, exports, internal deps, complexity scores | Free |
| `search_functions` | Find existing functions before writing new ones — name, signature, location, callers | Free |
| `get_blast_radius` | Trace all downstream callers up to 5 hops before refactoring | Free |
| `query_dependencies` | Forward, reverse, and circular dependency tracing between modules | Free |
| `check_reachability` | Verify exports are wired to production entry points | Pro |
| `get_regression_risk` | Score functions by complexity, exposure, churn, and caller count | Pro |
| `get_unused_code` | Graph-based dead code detection with text-reference backup | Pro |
| `get_consolidation_opportunities` | Detect duplicate logic, parallel consumers, signature twins | Pro |
| `get_test_coverage` | Per-module coverage with untested high-complexity function flagging | Pro |
| `get_vision_docs` | Cross-reference PRDs and specs against implementation | Pro |
| `get_vision_gaps` | Find specs without code and complex code without specs | Pro |
| `get_cross_repo_audit` | Compare two repositories for structural duplication and drift | Pro |

---

## Example Session

```
You: "What breaks if I rename formatMessage?"

Pharaoh → get_blast_radius
  Risk: HIGH
  Direct callers: 4 (across 3 modules)
  Transitive impact: 12 functions
  Affected endpoints: POST /api/notifications/send, POST /api/slack/webhook
  Affected cron: daily-digest (09:00 UTC)

You: "Is there already a retry wrapper?"

Pharaoh → search_functions
  Found: withRetry() in src/utils/resilience.ts:42
  Exported: yes | Async: yes | Complexity: 8
  Used by 6 callers across 3 modules
  → Agent imports existing function instead of writing a new one.
```

---

## How It Works

- **Tree-sitter parsing** (deterministic, no LLM) into a Neo4j knowledge graph
- **GitHub webhook** auto-refreshes on every push to default branch
- ~60 seconds to map a 50K LOC TypeScript project
- Structural metadata only — **no source code stored**

---

## FAQ

**Does Pharaoh store my source code?**
No. The graph contains function names, file paths, dependency relationships, complexity scores, and export signatures. Never source code.

**What languages are supported?**
TypeScript and Python today. Tree-sitter makes adding languages straightforward.

**How does it stay current?**
GitHub webhook fires on every push. Your graph is always up to date.

**Can I use it with private repos?**
Yes. Read-only access via the GitHub App. Tenant-isolated — your data is never visible to other customers.

**How is this different from Sourcegraph / CodeScene / SonarQube?**
Sourcegraph answers "where is it?" — text search across repos. CodeScene analyzes behavioral patterns from git history. SonarQube does line-level static analysis and linting. Pharaoh answers "what breaks if I change this?" — structural and architectural intelligence built for AI agents, not dashboards.

---

## Links

- Website: [pharaoh.so](https://pharaoh.so)
- Setup & Pricing: [pharaoh.so/setup](https://pharaoh.so/setup)

Built by a dev who got tired of AI agents breaking things they couldn't see.
