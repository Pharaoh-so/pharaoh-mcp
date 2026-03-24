# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in Pharaoh, please report it responsibly.

**Do not open a public issue.**

Email [security@pharaoh.so](mailto:security@pharaoh.so) with:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact assessment
4. Any suggested fixes (optional)

We will acknowledge receipt within 48 hours and provide a detailed response within 7 business days.

## Security Model

- **No source code stored** — Pharaoh maps structural metadata (function names, file paths, dependencies, complexity scores) into a knowledge graph. Your source code never leaves your machine.
- **Tenant isolation** — every query is repo-anchored and ownership-verified. Two independent layers prevent cross-tenant data access.
- **Encrypted at rest** — GitHub tokens and sensitive graph properties use AES-256-GCM with per-tenant HKDF-derived keys.
- **Webhook verification** — all GitHub and Stripe webhooks are HMAC-verified on every request.
- **Token security** — tokens stored as SHA-256 hashes, never plaintext. Org membership re-checked on every token refresh.
- **Rate limiting** — per-tenant rate limiting prevents abuse.

## Credential Storage (npm package)

The `@pharaoh-so/mcp` npm package stores credentials at `~/.pharaoh/credentials.json` with `0600` permissions (owner-read/write only). Tokens expire after 7 days and are refreshed automatically.
