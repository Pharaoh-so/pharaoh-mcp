# Pharaoh

[![npm version](https://img.shields.io/npm/v/@pharaoh-so/mcp)](https://www.npmjs.com/package/@pharaoh-so/mcp)
[![license](https://img.shields.io/github/license/Pharaoh-so/pharaoh-mcp)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io/)
[![Pharaoh MCP server](https://glama.ai/mcp/servers/Pharaoh-so/pharaoh/badge)](https://glama.ai/mcp/servers/Pharaoh-so/pharaoh)

**Codebase intelligence for AI agents. Your AI understands your architecture before it writes a single line.**

Pharaoh parses repositories using [tree-sitter](https://tree-sitter.github.io/) and maps structural metadata into a [Neo4j](https://neo4j.com/) knowledge graph — functions, modules, imports, exports, call chains, endpoints, complexity scores, all mapped as nodes and edges. AI agents query the graph via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) for structured architectural context instead of reading files one at a time.

Deterministic analysis — no LLM in the pipeline, zero hallucination risk. **No source code stored.**

[pharaoh.so](https://pharaoh.so) · [Documentation](https://docs.pharaoh.so) · [Report an Issue](https://github.com/Pharaoh-so/pharaoh-mcp/issues)

---

## Quick Start (60 seconds)

### Claude Code (Desktop — Browser Available)

```bash
claude mcp add pharaoh --transport sse https://mcp.pharaoh.so/sse
```

### Claude Code (Headless — VPS, SSH, CI)

```bash
claude mcp add pharaoh -- npx @pharaoh-so/mcp
```

The `@pharaoh-so/mcp` npm package acts as a stdio-to-SSE proxy with [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) device flow auth — no browser required on the machine running Claude Code. See the [npm package README](https://www.npmjs.com/package/@pharaoh-so/mcp) for details.

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

### Windsurf

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "pharaoh": {
      "serverUrl": "https://mcp.pharaoh.so/sse"
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

## Tools (19 Total)

### Orient (Free)

| Tool | What it answers |
|------|----------------|
| `get_codebase_map` | What modules exist and how do they relate? — **start here** |
| `get_module_context` | What does this module look like before I modify it? |
| `search_functions` | Does this function already exist somewhere? |
| `get_design_system` | What UI components and tokens already exist? |

### Investigate (Free + Pro)

| Tool | Tier | What it answers |
|------|------|----------------|
| `get_blast_radius` | Free | What breaks if I change this function/file/module? |
| `query_dependencies` | Free | How are these two modules connected? |
| `check_reachability` | Pro | Is this function actually reachable from entry points? |
| `get_vision_docs` | Pro | Is there a PRD or spec for this? |

### Audit (Pro)

| Tool | What it answers |
|------|----------------|
| `get_vision_gaps` | What's specified but not built? What's built but not specified? |
| `get_cross_repo_audit` | Are shared dependencies drifting between repos? |
| `get_consolidation_opportunities` | Where is duplicate or overlapping logic? |
| `get_unused_code` | What code is never called and safe to delete? |
| `get_test_coverage` | Which modules/functions lack test coverage? |
| `get_regression_risk` | How risky is this change to production? |

### Manage (Free)

| Tool | What it does |
|------|-------------|
| `request_upload` | Map a local repo without installing the GitHub App |
| `setup_environment` | Install recommended development plugins |
| `pharaoh_account` | Check plan, toggle PR Guard, trigger refresh |
| `pharaoh_feedback` | Report false positives or tool issues |
| `pharaoh_admin` | Org-level administration |

---

## Example Sessions

### Blast Radius Before Refactoring

```
You: "What breaks if I rename formatMessage?"

Pharaoh → get_blast_radius
  Risk: HIGH
  Direct callers: 4 (across 3 modules)
  Transitive impact: 12 functions
  Affected endpoints: POST /api/notifications/send, POST /api/slack/webhook
  Affected cron: daily-digest (09:00 UTC)
```

### Avoiding Duplicate Code

```
You: "Is there already a retry wrapper?"

Pharaoh → search_functions
  Found: withRetry() in src/utils/resilience.ts:42
  Exported: yes | Async: yes | Complexity: 8
  Used by 6 callers across 3 modules
  → Agent imports existing function instead of writing a new one.
```

### Dead Code Cleanup

```
You: "What code can I safely delete?"

Pharaoh → get_unused_code
  Dead (safe to remove): 23 functions across 8 files
  Likely dead (verify first): 5 functions with dynamic-only references
  Estimated LOC reduction: ~450 lines
```

### Pre-Change Risk Assessment

```
You: "How risky is changing the auth middleware?"

Pharaoh → get_regression_risk
  Risk: CRITICAL (score: 92/100)
  Reason: 47 downstream callers, 3 entry points, complexity 24
  Recommendation: staged rollout with integration tests
```

---

## How It Works

```
GitHub App (install) → Pharaoh → tree-sitter parse → Neo4j knowledge graph
GitHub App (push)    → Pharaoh → incremental refresh → graph updated
AI Agent (query)     → MCP → Cypher query → structured response
```

- **Tree-sitter parsing** — deterministic AST analysis, no LLM involved
- **Neo4j knowledge graph** — functions, files, modules, dependencies mapped as nodes and edges
- **GitHub webhook** — auto-refreshes the graph on every push to the default branch
- **~60 seconds** to map a 50K LOC TypeScript project
- **Structural metadata only** — function names, file paths, dependency relationships, complexity scores, export signatures. **Never source code.**

### Supported Languages

| Language | Status |
|----------|--------|
| TypeScript / JavaScript | Full support (functions, classes, imports, exports, JSX) |
| Python | Full support (functions, classes, imports, decorators) |
| More languages | Planned via tree-sitter grammar support |

---

## npm Package (`@pharaoh-so/mcp`)

For headless environments where a browser isn't available for OAuth:

```bash
# Authenticate (run once — opens device flow)
npx @pharaoh-so/mcp

# Add to Claude Code
claude mcp add pharaoh -- npx @pharaoh-so/mcp
```

The package is a thin stdio-to-SSE proxy (~25KB). One dependency (`@modelcontextprotocol/sdk`). Credentials stored at `~/.pharaoh/credentials.json` with `0600` permissions.

```
Claude Code ← stdio → @pharaoh-so/mcp ← SSE/HTTP → mcp.pharaoh.so
```

See the [npm package page](https://www.npmjs.com/package/@pharaoh-so/mcp) for full documentation.

---

## Security

- **No source code stored** — only structural metadata in the knowledge graph
- **Tenant isolation** — every query is repo-anchored and ownership-verified via two independent layers
- **Encrypted at rest** — GitHub tokens and sensitive graph properties use AES-256-GCM with per-tenant HKDF-derived keys
- **Webhook verification** — all GitHub and Stripe webhooks are HMAC-verified
- **Token security** — tokens stored as SHA-256 hashes, never plaintext
- **Rate limiting** — per-tenant rate limiting prevents abuse
- **Org membership** — re-checked on every token refresh (max 1hr staleness)

See [SECURITY.md](SECURITY.md) for the full security policy and vulnerability reporting.

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

**What MCP clients are supported?**
Any MCP-compatible client: Claude Code, Cursor, Windsurf, Cline, Continue, and any client that supports SSE transport.

**Is there a free tier?**
Yes. The Orient tools (`get_codebase_map`, `get_module_context`, `search_functions`, `get_design_system`) and core Investigate tools (`get_blast_radius`, `query_dependencies`) are free. Pro tools require a subscription.

**How do I map repos without the GitHub App?**
Use the `request_upload` tool to map local repositories directly.

---

## Contributing

We welcome contributions. Please read our [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) before getting started.

## License

[MIT](LICENSE)

## Links

- [Website](https://pharaoh.so)
- [Documentation](https://docs.pharaoh.so)
- [npm Package](https://www.npmjs.com/package/@pharaoh-so/mcp)
- [MCP Specification](https://modelcontextprotocol.io/)
- [Report an Issue](https://github.com/Pharaoh-so/pharaoh-mcp/issues)
- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

---

Built by a dev who got tired of AI agents breaking things they couldn't see.
