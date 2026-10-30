# Pharaoh

Pharaoh maps your GitHub repositories into a graph of modules, functions, call relationships, endpoints, cron jobs and dependencies, for TypeScript, JavaScript and Python. Each graph covers a repo's default branch and is re-mapped on every push to it. This plugin adds four Claude Code skills that query that graph, plus the Pharaoh connector they query through.

## What's in the plugin

- **plan** reviews an implementation plan before any code is written. It pulls the architecture map, the profiles of the modules the plan touches and the blast radius of the functions it changes. Then it asks whether this is a big or a small change and works through architecture, code quality, wiring, tests, performance and security, with a decision for each issue it finds.
- **review** reviews the current branch against its base. It finds the changed files with git, maps them to modules, checks the blast radius of the riskiest changes, runs focused reviewers for code quality, security, error handling, tests and types, and ends with a verdict of SHIP, SHIP WITH CHANGES or BLOCK.
- **refactor** plans a refactor of a function or module. It reads the module's profile, the target's detected callers and any existing function with the new name, then lists the callers to update, the tests to change, unreachable code, high-risk paths and naming conflicts.
- **pharaoh** tells Claude which Pharaoh tool answers which question: whether a function already exists, what calls it, what a module contains, what code nothing runs and how the repo is laid out.
- **Connector reference.** The plugin registers Pharaoh's MCP server at `https://mcp.pharaoh.so/mcp`.

## How to use it

Open Claude Code in a local checkout of a repo Pharaoh maps, then run `/pharaoh:plan` with your plan, `/pharaoh:review` on a branch, or `/pharaoh:refactor` with the function or module you want to change. Claude can also pick one of these skills when your request matches it.

Without the connector, plan and review fall back to searching and reading files. The refactor skill needs the connector.

## Connect

1. In Claude Code, run `/mcp`, select `pharaoh` and sign in with GitHub.
2. Install the Pharaoh GitHub App on the personal account or organization that owns your code, and choose the repositories it can read: https://github.com/apps/pharaoh-so/installations/new
3. Wait for the first map. The setup page at https://mcp.pharaoh.so/setup shows its progress.

Free keeps one repo live. Pro keeps every repo live.

## What data it sends, and where

- **To `mcp.pharaoh.so`:** each Pharaoh tool call, with the arguments Claude fills in: a repo name and, depending on the tool, a module, function or file name, or search text. Pharaoh logs each call with its arguments for rate limiting, debugging and the audit trail, for 90 days. A text argument over 500 characters is cut to 500, though text inside a list argument is kept in full, and arguments named token, password, secret, key, authorization or credential are replaced with `[REDACTED]`. Signing in shares your GitHub identity with Pharaoh: your user ID, username, name, avatar, organization memberships and primary verified email. Pharaoh keeps your GitHub sign-in token, encrypted, to re-check which organizations and repositories you can reach.
- **Through the GitHub App:** Pharaoh reads the repositories you install it on and builds the graph from them. Mapping uses a temporary clone that is deleted when the job ends. The graph keeps names, file paths, signatures, dependencies, up to 200 characters of each doc comment or docstring, and top-level constant values of up to 128 characters, and doesn't store source files or function bodies. The App's only write permission is posting check results to GitHub.
- **Nothing else.** The plugin has no hooks or scripts. The skills run git and read your files locally through Claude Code, the same as any other session. If the GitHub CLI is installed and signed in, review runs `gh pr view` to ask GitHub for the open PR's target branch.

## Privacy

Pharaoh doesn't store source code, function bodies, environment variable values, commit messages or diffs. Uninstalling the GitHub App revokes its access and starts a 30-day retention period, after which the account's graphs and data are deleted. Read the full policy at <https://pharaoh.so/docs/use-pharaoh/terms-and-privacy#privacy>, or email privacy@pharaoh.so.
