# Contributing to Pharaoh

Thank you for your interest in contributing to Pharaoh.

## Ways to Contribute

### Bug Reports

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Your MCP client (Claude Code, Cursor, etc.)
- Any relevant error messages

### Feature Requests

Open an issue describing:
- The problem you're trying to solve
- Your proposed solution
- Alternative approaches you've considered

### Feedback

Use the `pharaoh_feedback` MCP tool directly from your AI client to report false positives, tool issues, or suggestions. This creates a tracked issue automatically.

## Development

The Pharaoh MCP server is a hosted service at `mcp.pharaoh.so`. The `@pharaoh-so/mcp` npm package is a thin stdio-to-SSE proxy that enables headless environments.

### npm Package (`@pharaoh-so/mcp`)

```bash
# Clone
git clone https://github.com/Pharaoh-so/pharaoh-mcp.git
cd pharaoh-mcp

# Install
npm install

# Build
npm run build

# Test
npm test
```

### Code Style

- TypeScript with strict mode
- Biome for linting and formatting
- Vitest for testing

## Code of Conduct

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before contributing.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
