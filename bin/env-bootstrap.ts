/**
 * Side-effect-only module imported BEFORE @earendil-works/pi-coding-agent.
 *
 * Upstream's config.js evaluates env vars at module top level — by the time
 * any sibling import statement runs, it's already frozen. ESM hoists all
 * imports to the top of the file before executing any top-level code, so we
 * can't set process.env in bin/pico.ts directly; we have to stash the
 * assignments in a module that gets imported first in source order.
 *
 * Redirects pi-coding-agent's config/session dirs from ~/.pi to ~/.pico/agent
 * (preserving any explicit override the user already set).
 *
 * In compiled-binary mode, the embedded package.json sets piConfig.name="pico"
 * which makes pi's config.js read PICO_CODING_AGENT_DIR instead of
 * PI_CODING_AGENT_DIR — so we set both names to be safe across modes.
 *
 * Also hydrates env vars from settings.json so API keys like TAVILY_API_KEY
 * stored in settings are available at startup.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Normalize exactly like paths.ts's picoHome(): expand a leading ~ and
// resolve relative overrides against the cwd, so PI_CODING_AGENT_DIR here and
// picoHome()/picoAgentHome() downstream agree on the same absolute root.
const picoHomeOverride = process.env.PICO_HOME && process.env.PICO_HOME.length > 0
  ? process.env.PICO_HOME.replace(/^~(?=\/|$)/, homedir())
  : null;
const picoHome = picoHomeOverride ? resolve(picoHomeOverride) : join(homedir(), ".pico");
const agentDir = join(picoHome, "agent");
const sessionDir = join(agentDir, "sessions");

process.env.PI_CODING_AGENT_DIR ??= agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR ??= sessionDir;
process.env.PICO_CODING_AGENT_DIR ??= agentDir;
process.env.PICO_CODING_AGENT_SESSION_DIR ??= sessionDir;

// Upstream pi checks https://pi.dev/api/latest-version against the runtime
// package version. pico is a wrapper with its own release cadence, so that
// check reports misleading "pico update" prompts when only pi changed.
process.env.PI_SKIP_VERSION_CHECK ??= "1";

// Resolve the upstream package directory so pi-coding-agent can find its
// built-in themes / assets (getThemesDir walks up from PI_PACKAGE_DIR).
//
// In compiled-binary mode, bin/pico.ts extracts embedded assets to a temp
// dir and sets PI_PACKAGE_DIR itself. In source mode (bun run bin/pico.ts),
// nothing sets it, so pi falls back to a wrong path and crashes on theme
// load. Default it here to the installed upstream package in node_modules.
const IS_BUN_BINARY =
  import.meta.url.includes("$bunfs") ||
  import.meta.url.includes("~BUN") ||
  import.meta.url.includes("%7EBUN");
if (!IS_BUN_BINARY) {
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const upstream = join(
    projectRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const hasAssets = (p: string | undefined) =>
    !!p && (existsSync(join(p, "dist")) || existsSync(join(p, "src")));
  // Trust an existing PI_PACKAGE_DIR only if it actually holds pi's assets.
  // A stale/empty value (e.g. inherited from a wrapper harness) breaks theme
  // resolution, so fall back to the installed upstream package in that case.
  if (hasAssets(upstream) && !hasAssets(process.env.PI_PACKAGE_DIR)) {
    process.env.PI_PACKAGE_DIR = upstream;
  }
}

// Hydrate env vars from settings.json (keys under the "env" stanza).
const settingsPath = join(agentDir, "settings.json");
try {
  const raw = readFileSync(settingsPath, "utf-8");
  const settings = JSON.parse(raw);
  const envVars = settings.env;
  if (envVars && typeof envVars === "object" && !Array.isArray(envVars)) {
    for (const [key, value] of Object.entries(envVars)) {
      if (typeof value === "string" && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
} catch {
  // settings.json doesn't exist or is invalid — no env vars to hydrate.
}
