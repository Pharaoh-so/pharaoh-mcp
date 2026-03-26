# @pharaoh-so/mcp

[![npm version](https://img.shields.io/npm/v/@pharaoh-so/mcp)](https://www.npmjs.com/package/@pharaoh-so/mcp)
[![license](https://img.shields.io/npm/l/@pharaoh-so/mcp)](https://github.com/Pharaoh-so/pharaoh-mcp/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@pharaoh-so/mcp)](https://nodejs.org)
[![pharaoh MCP server](https://glama.ai/mcp/servers/Pharaoh-so/pharaoh/badges/score.svg)](https://glama.ai/mcp/servers/Pharaoh-so/pharaoh)

MCP proxy for [Pharaoh](https://pharaoh.so) — maps codebases into queryable knowledge graphs for AI agents.

Pharaoh gives AI coding assistants a complete architectural map of your codebase: every function, dependency, module, and connection. Instead of reading files one at a time, your AI agent queries the knowledge graph and gets instant answers about blast radius, unused code, dependency chains, and more.

This package enables [Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code) to connect to Pharaoh in **headless environments** (VPS, SSH, containers, CI) where a browser isn't available for OAuth. It acts as a stdio-to-SSE proxy, presenting itself as a local MCP server while relaying all communication to the remote Pharaoh server.

## Quick Start

### Step 1 — Authenticate

Run the proxy directly to trigger the device authorization flow:

```bash
npx @pharaoh-so/mcp
```

This displays a device code and a URL. Open the URL on **any device** (phone, laptop, tablet) and enter the code to authorize. Credentials are saved to `~/.pharaoh/credentials.json` and remain valid for 7 days, with automatic re-authorization when they expire.

### Step 2 — Add to Claude Code

```bash
claude mcp add pharaoh -- npx @pharaoh-so/mcp
```

Verify the connection:

```bash
claude mcp list
```

You should see `pharaoh` listed as a **stdio** server.

### Switching from SSE

If you previously added Pharaoh as an SSE server, remove it first:

```bash
claude mcp remove pharaoh
claude mcp add pharaoh -- npx @pharaoh-so/mcp
```

### Desktop with Browser (Alternative)

If you have a browser available (desktop, laptop), you can connect directly via SSE instead:

```bash
claude mcp add --transport sse --scope user pharaoh https://mcp.pharaoh.so/sse
```

This uses OAuth in the browser and doesn't require this package.

## How It Works

```
Claude Code ← stdio → @pharaoh-so/mcp ← SSE/HTTP → mcp.pharaoh.so
```

The proxy implements the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) specification:

1. **Claude Code** launches the proxy as a child process and communicates via **stdio** (stdin/stdout)
2. **The proxy** authenticates with Pharaoh using stored credentials (or triggers device flow)
3. **All MCP messages** (tool calls, responses, notifications) are relayed to the remote Pharaoh server over **SSE** (Server-Sent Events)
4. **Pharaoh** queries the knowledge graph and returns architectural data to the proxy
5. **The proxy** forwards responses back to Claude Code via stdio

Authentication uses [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) (OAuth 2.0 Device Authorization Grant) — no browser is needed on the machine running Claude Code.

## Available Tools

Once connected, Pharaoh provides 19 MCP tools organized into four categories:

### Orient (Free)

| Tool | What it answers |
|------|----------------|
| `get_codebase_map` | What modules exist and how do they relate? |
| `get_module_context` | What does this module look like before I modify it? |
| `search_functions` | Does this function already exist somewhere? |
| `get_design_system` | What UI components and tokens already exist? |

### Investigate (Free + Pro)

| Tool | What it answers |
|------|----------------|
| `get_blast_radius` | What breaks if I change this function/file/module? |
| `query_dependencies` | How are these two modules connected? |
| `check_reachability` | Is this function actually reachable from entry points? |
| `get_vision_docs` | Is there a PRD or spec for this? |

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

| Tool | What it answers |
|------|----------------|
| `request_upload` | Map a local repo without installing the GitHub App |
| `setup_environment` | Install recommended development plugins |
| `pharaoh_account` | Check plan, toggle PR Guard, trigger refresh |
| `pharaoh_feedback` | Report false positives or tool issues |
| `pharaoh_admin` | Org-level administration |

## Inspect Mode

Use `--inspect` to dump the full tool manifest as JSON (useful for MCP registry validation and debugging):

```bash
npx @pharaoh-so/mcp --inspect
```

This outputs the complete list of tools with their schemas and exits immediately, without connecting to the server.

## CLI Options

```
Usage: pharaoh-mcp [options]

Options:
  --server <url>   Pharaoh server URL (default: https://mcp.pharaoh.so)
  --logout         Clear stored credentials and exit
  --inspect        Output tool manifest as JSON and exit
  --help           Show help
  --version        Show version number
```

## Configuration

### Credentials

Credentials are stored at `~/.pharaoh/credentials.json` with `0600` permissions (owner-read/write only). The file contains:

- **Access token** — used to authenticate MCP requests
- **Refresh token** — used to obtain new access tokens when they expire
- **Expiry timestamp** — tokens are refreshed automatically before expiration

To clear credentials:

```bash
npx @pharaoh-so/mcp --logout
```

### Custom Server

For self-hosted Pharaoh instances or development:

```bash
claude mcp add pharaoh -- npx @pharaoh-so/mcp --server https://your-pharaoh-instance.com
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PHARAOH_SERVER_URL` | `https://mcp.pharaoh.so` | Pharaoh server URL (alternative to `--server`) |

## Requirements

- **Node.js** >= 18
- **Claude Code** or any MCP-compatible AI client
- A **Pharaoh account** — sign up at [pharaoh.so](https://pharaoh.so)

## Security

- Credentials are stored with restrictive file permissions (`0600` — owner-read/write only)
- Authentication uses the [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) device authorization flow — no secrets are embedded in the package
- All communication with the Pharaoh server uses HTTPS/TLS
- No source code is ever transmitted — Pharaoh maps structural metadata (function names, file paths, dependency relationships) into a knowledge graph. Your code never leaves your machine.
- Tokens expire after 7 days and are refreshed automatically
- Only use trusted server URLs — the proxy sends your auth token to the configured server

### Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly by emailing [security@pharaoh.so](mailto:security@pharaoh.so). Do not open a public issue.

## Troubleshooting

### "Connection refused" or "ECONNREFUSED"

The Pharaoh server may be temporarily unavailable. Check [status.pharaoh.so](https://pharaoh.so) or try again in a few minutes.

### "Token expired" or "401 Unauthorized"

Re-authenticate by running the proxy directly:

```bash
npx @pharaoh-so/mcp
```

Or clear credentials and start fresh:

```bash
npx @pharaoh-so/mcp --logout
npx @pharaoh-so/mcp
```

### "pharaoh" not showing in `claude mcp list`

Make sure you added it with the correct command:

```bash
claude mcp add pharaoh -- npx @pharaoh-so/mcp
```

Note the `--` separator between `pharaoh` and `npx`.

### Device code not working

- Ensure you're opening the URL on a device with browser access
- The device code expires after 15 minutes — request a new one by re-running the command
- Check that you're logged into GitHub when authorizing

### Slow startup

The first run after installation may take a moment as npm downloads the package. Subsequent runs use the cached version. To pre-install globally:

```bash
npm install -g @pharaoh-so/mcp
claude mcp add pharaoh -- pharaoh-mcp
```

## How Pharaoh Works

Pharaoh parses your repositories using [tree-sitter](https://tree-sitter.github.io/) and maps structural metadata into a [Neo4j](https://neo4j.com/) knowledge graph. The graph contains:

- **Functions** — names, signatures, complexity scores, export visibility
- **Files** — paths, module membership, language classification
- **Modules** — logical groupings detected from directory structure
- **Dependencies** — import/export relationships, call chains, module connections
- **Vision specs** — PRD/spec documents linked to implementation

No source code is stored — only structural metadata. When an AI agent queries Pharaoh, it gets architectural facts in minimal tokens, not raw code dumps. This means your AI assistant can understand your entire codebase architecture without consuming its context window reading files one by one.

## Supported Languages

- **TypeScript / JavaScript** — full support (functions, classes, imports, exports, JSX)
- **Python** — full support (functions, classes, imports, decorators)
- More languages planned via tree-sitter grammar support

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE) -- Pharaoh, Inc.

## Links

- [Pharaoh website](https://pharaoh.so)
- [Documentation](https://docs.pharaoh.so)
- [MCP specification](https://modelcontextprotocol.io/)
- [Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code)
- [Report an issue](https://github.com/Pharaoh-so/pharaoh-mcp/issues)
