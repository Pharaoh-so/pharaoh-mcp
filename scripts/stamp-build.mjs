// Runs after `tsc` in `pnpm build`: makes dist/index.js an executable with a
// shebang, and regenerates the shipped .mcp.json so it runs this exact version
// (`npx @pharaoh-so/mcp@<version>`; security review SC-2). Commit .mcp.json
// when it changes, like inspect-tools.json.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const entry = join(root, "dist", "index.js");
const code = readFileSync(entry, "utf8");
if (!code.startsWith("#!")) writeFileSync(entry, `#!/usr/bin/env node\n${code}`);
chmodSync(entry, 0o755);

const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const mcp = { mcpServers: { pharaoh: { command: "npx", args: [`${name}@${version}`] } } };
writeFileSync(join(root, ".mcp.json"), `${JSON.stringify(mcp, null, "\t")}\n`);
