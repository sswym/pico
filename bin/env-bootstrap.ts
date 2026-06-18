/**
 * Side-effect-only module imported BEFORE @earendil-works/pi-coding-agent.
 *
 * Upstream's config.js evaluates env vars at module top level — by the time
 * any sibling import statement runs, it's already frozen. ESM hoists all
 * imports to the top of the file before executing any top-level code, so we
 * can't set process.env in bin/srcode.ts directly; we have to stash the
 * assignments in a module that gets imported first in source order.
 *
 * Redirects pi-coding-agent's config/session dirs from ~/.pi to ~/.srcode/agent
 * (preserving any explicit override the user already set).
 *
 * In compiled-binary mode, the embedded package.json sets piConfig.name="srcode"
 * which makes pi's config.js read SRCODE_CODING_AGENT_DIR instead of
 * PI_CODING_AGENT_DIR — so we set both names to be safe across modes.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const agentDir = join(home, ".srcode", "agent");
const sessionDir = join(home, ".srcode", "agent", "sessions");

process.env.PI_CODING_AGENT_DIR ??= agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR ??= sessionDir;
process.env.SRCODE_CODING_AGENT_DIR ??= agentDir;
process.env.SRCODE_CODING_AGENT_SESSION_DIR ??= sessionDir;

// Upstream pi checks https://pi.dev/api/latest-version against the runtime
// package version. srcode is a wrapper with its own release cadence, so that
// check reports misleading "srcode update" prompts when only pi changed.
process.env.PI_SKIP_VERSION_CHECK ??= "1";

// Disable the upstream shift+tab → cycle thinking level shortcut so srcode
// can repurpose shift+tab for permission-mode cycling. Thinking level
// remains settable via /settings. We only write the keybindings file if it
// doesn't already exist — users who have customised their keybindings are
// left alone.
{
  const keybindingsPath = join(agentDir, "keybindings.json");
  if (!existsSync(keybindingsPath)) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(keybindingsPath, JSON.stringify({ "app.thinking.cycle": [] }, null, 2) + "\n");
  }
}
