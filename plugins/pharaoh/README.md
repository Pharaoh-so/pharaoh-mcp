# Pharaoh

Pharaoh maps your GitHub repositories into a graph of modules, functions, call relationships, endpoints, cron jobs and dependencies, for TypeScript, JavaScript and Python. Each graph covers a repo's default branch and is re-mapped on every push to it. This plugin adds four skills that query that graph, plus the Pharaoh connector they query through.

## What's in the plugin

- **plan** reviews an implementation plan before any code is written. It pulls the architecture map, the profiles of the modules the plan touches and the blast radius of the functions it changes. Then it asks whether this is a big or a small change and works through architecture, code quality, wiring, tests, performance and security, with a decision for each issue it finds.
- **review** reviews the current branch against its base. It finds the changed files with git, maps them to modules, checks the blast radius of the riskiest changes, runs focused reviewers for code quality, security, error handling, tests and types, and ends with a verdict of SHIP, SHIP WITH CHANGES or BLOCK.
- **refactor** plans a refactor of a function or module. It reads the module's profile, the target's detected callers and any existing function with the new name, then lists the callers to update, the tests to change, unreachable code, high-risk paths and naming conflicts.
- **pharaoh** tells Claude which Pharaoh tool answers which question: whether a function already exists, what calls it, what a module contains, what code nothing runs and how the repo is laid out.
- **Connector reference.** The plugin registers Pharaoh's MCP server at `https://mcp.pharaoh.so/mcp`.

## How to use it

Open Claude Code in a local checkout of a repo Pharaoh maps, then run `/pharaoh:plan` with your plan, `/pharaoh:review` on a branch, or `/pharaoh:refactor` with the function or module you want to change. Claude can also pick one of these skills when your request matches it. On claude.ai and in Cowork, ask for a plan review, a code review or a refactor plan.

Without the connector, plan and review fall back to searching and reading files. The refactor skill needs the connector and a mapped repo, and stops without them.

## Connect

1. Connect the plugin's Pharaoh connector and sign in with GitHub:
   - **Claude Code:** run `/mcp` and select `plugin:pharaoh:pharaoh`.
   - **claude.ai and Cowork:** open Pharaoh in Customize > Plugins and use its Connectors tab.
2. Install the Pharaoh GitHub App on the personal account or organization that owns your code, and choose the repositories it can read: https://github.com/apps/pharaoh-so/installations/new
3. Wait for the first map. The setup page at https://mcp.pharaoh.so/setup shows its progress.

Every repo is mapped during the trial and on Pro. After the trial, get_codebase_map keeps answering.

## What data it sends, and where

This is a summary. The [privacy policy](https://pharaoh.so/docs/use-pharaoh/terms-and-privacy#privacy) has the complete list of what's recorded, why and for how long.

- **To `mcp.pharaoh.so`:** each Pharaoh tool call, with the arguments Claude fills in: a repo name and, depending on the tool, a module, function or file name, or search text. Pharaoh logs each call for 90 days, including its arguments and your GitHub user ID and username, and keeps milestones such as your first sign-in, first map and first tool call for 90 days too. The logs record rate-limit refusals and serve debugging, the audit trail, onboarding, scheduling map refreshes and product analytics. A text argument over 500 characters is cut to 500, though text inside a list argument is kept in full, and arguments with secret-like names such as token or password are replaced with `[REDACTED]`.
- **Back to your agent:** tool results go to the agent you connect and the model provider behind it, which handle them under their own terms.
- **In server logs:** application logs of sign-ins, errors and refused requests, which can include GitHub usernames and IDs, repo names, and an IP address or user agent. They're kept for 14 days.
- **In alert records:** internal alerts can name an account, a repo or a GitHub username. They're kept for 90 days.
- **On the setup page and pharaoh.so:** a `ph_vid` cookie holds a random visitor ID, and Pharaoh records how you use these pages, including what you view and click and where you came from, for 90 days. Signing in links that visitor ID to your GitHub account.
- **When you connect:** each session records your agent's details, such as its name and version, for 90 days. Signing in shares your GitHub identity with Pharaoh, including your user ID, username, organization memberships and primary verified email. Pharaoh keeps your GitHub sign-in token, encrypted, to re-check which organizations and repositories you can reach.
- **Your email:** Pharaoh sends at most two setup emails to your primary verified address through Resend, which reports whether each was delivered, bounced, opened or clicked, and for a click, the IP address and browser that clicked. Installing the GitHub App starts its owner's Pro trial, which creates a Stripe customer for that person, as subscribing does; installing and signing in create none for the account itself. An account that already has its own Stripe customer from before Pro keeps it, and signing in from an agent or the billing page sets your address as that customer's email.
- **Through the GitHub App:** Pharaoh reads the repositories you install it on and builds the graph from them. Mapping uses a temporary clone that is deleted when the job ends. The graph keeps what the code declares and how it connects, such as names, file paths, imports and calls, routes, cron schedules, signatures as written, short doc comment excerpts, top-level constant values, one-way hashes of function bodies and file history. It doesn't store source files or function bodies. Signatures, doc comments and constant values are copied from your code, so they can hold code or hard-coded values. Mapping-quality records, kept for 90 days, can include import paths a map couldn't resolve. On Pro, PR Guard checks pull requests the same way and keeps a record of each check for 90 days. The App's only write permission is posting check results to GitHub.
- **In your session:** the plugin has no hooks or scripts. The skills run git and read your files through Claude, the same as any other session, and Pharaoh gets none of it unless it's in a tool argument. If the GitHub CLI is installed and signed in, review runs `gh pr view` to ask GitHub for the open PR's target branch.

## Privacy

Pharaoh doesn't store source code, function bodies, environment variable values, commit messages or diffs. Uninstalling the GitHub App revokes its access and starts a 30-day retention period, after which the account's graphs and data are deleted. What stays: a record under your GitHub user ID that you unsubscribed or that your address bounced, so you're never emailed again; your own records, if you also belong to another Pharaoh account; and the payment records Stripe is required to keep. Records on their own clock, such as alert records, server logs and hosting backups, age out on it. Pharaoh runs on Render, Neo4j Aura and Cloudflare, and the [privacy policy](https://pharaoh.so/docs/use-pharaoh/terms-and-privacy#privacy) lists every provider and retention period. For a data request, email privacy@pharaoh.so.
