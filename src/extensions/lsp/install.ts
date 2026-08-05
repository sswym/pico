/**
 * LSP server auto-installer.
 *
 * Maps known LSP server commands to their install commands, grouped by
 * package manager. Detects which package managers are available on the
 * system and picks the best one.
 */
import { spawnSync } from "node:child_process";

// ── Install hint types ────────────────────────────────────────────────────

type PackageManager = "npm" | "pip" | "pipx" | "cargo" | "go" | "opam" | "system";

export interface InstallHint {
  readonly command: string;
  readonly packageName: string;
  readonly manager: PackageManager;
}

interface InstallEntry {
  manager: PackageManager;
  pkg: string;
  /** Override the install command if the default `manager install pkg` doesn't work. */
  command?: string;
}

// ── Install registry ──────────────────────────────────────────────────────

const INSTALL_REGISTRY: Record<string, InstallEntry> = {
  // TypeScript / JavaScript
  "typescript-language-server": { manager: "npm", pkg: "typescript-language-server" },
  "vscode-html-language-server": { manager: "npm", pkg: "vscode-langservers-extracted" },
  "vscode-css-language-server": { manager: "npm", pkg: "vscode-langservers-extracted" },
  "vscode-json-language-server": { manager: "npm", pkg: "vscode-langservers-extracted" },
  "tailwindcss": { manager: "npm", pkg: "@tailwindcss/language-server" },
  "svelte": { manager: "npm", pkg: "svelte-language-server" },
  "vue-language-server": { manager: "npm", pkg: "@vue/language-server" },
  "astro": { manager: "npm", pkg: "@astrojs/language-server" },
  "eslint": { manager: "npm", pkg: "eslint" },
  "biome": { manager: "npm", pkg: "@biomejs/biome" },

  // Python
  "pyright": { manager: "npm", pkg: "pyright" },
  "basedpyright": { manager: "pip", pkg: "basedpyright" },
  "pylsp": { manager: "pip", pkg: "python-lsp-server" },
  "ruff": { manager: "pip", pkg: "ruff" },

  // Rust
  "rust-analyzer": {
    manager: "system",
    pkg: "rust-analyzer",
    command: "rustup component add rust-analyzer",
  },

  // Go
  "gopls": { manager: "go", pkg: "golang.org/x/tools/gopls@latest" },

  // C / C++
  "clangd": { manager: "system", pkg: "clangd" },

  // Java
  "jdtls": { manager: "system", pkg: "jdtls" },

  // Kotlin
  "kotlin-lsp": { manager: "system", pkg: "kotlin-language-server" },

  // Haskell
  "hls": { manager: "system", pkg: "haskell-language-server-wrapper" },

  // OCaml
  "ocamllsp": { manager: "opam", pkg: "ocaml-lsp-server" },

  // Elixir
  "elixirls": { manager: "system", pkg: "elixir-ls" },

  // Erlang
  "erlangls": { manager: "system", pkg: "erlang_ls" },

  // Gleam
  "gleam": { manager: "system", pkg: "gleam" },

  // Ruby
  "solargraph": { manager: "system", pkg: "solargraph" },
  "ruby-lsp": { manager: "system", pkg: "ruby-lsp" },
  "rubocop": { manager: "system", pkg: "rubocop" },

  // PHP
  "phpactor": { manager: "system", pkg: "phpactor" },
  "intelephense": { manager: "npm", pkg: "intelephense" },

  // C#
  "omnisharp": { manager: "system", pkg: "omnisharp" },

  // Lua
  "lua-language-server": { manager: "system", pkg: "lua-language-server" },

  // Nix
  "nil": { manager: "system", pkg: "nil" },
  "nixd": { manager: "system", pkg: "nixd" },

  // Zig
  "zls": { manager: "system", pkg: "zls" },

  // Shell
  "bashls": { manager: "npm", pkg: "bash-language-server" },

  // YAML
  "yamlls": { manager: "npm", pkg: "yaml-language-server" },

  // TOML
  "taplo": { manager: "cargo", pkg: "taplo-cli" },

  // SQL
  "sqls": { manager: "go", pkg: "github.com/sqls-server/sqls@latest" },

  // Terraform
  "terraform-ls": { manager: "system", pkg: "terraform-ls" },

  // Docker
  "dockerfile-language-server": { manager: "npm", pkg: "dockerfile-language-server-nodejs" },

  // Prisma
  "prismals": { manager: "npm", pkg: "@prisma/language-server" },

  // GraphQL
  "graphql-language-service": { manager: "npm", pkg: "graphql-language-service-cli" },

  // Swift
  "sourcekit-lsp": { manager: "system", pkg: "sourcekit-lsp" },

  // Dart
  "dart": { manager: "system", pkg: "dart" },

  // Coq
  "expert": { manager: "system", pkg: "expert" },

  // TLA+
  "tlaplus": { manager: "system", pkg: "tlauc" },
};

// ── Package manager detection ─────────────────────────────────────────────

let detectedManagers: Set<PackageManager> | null = null;

function hasCommand(name: string): boolean {
  const r = spawnSync("which", [name], { stdio: "ignore" });
  return r.status === 0;
}

function getAvailableManagers(): Set<PackageManager> {
  if (detectedManagers) return detectedManagers;
  const m = new Set<PackageManager>();
  if (hasCommand("npm")) m.add("npm");
  if (hasCommand("pip3")) m.add("pip");
  else if (hasCommand("pip")) m.add("pip");
  if (hasCommand("pipx")) m.add("pipx");
  if (hasCommand("cargo")) m.add("cargo");
  if (hasCommand("go")) m.add("go");
  if (hasCommand("opam")) m.add("opam");
  detectedManagers = m;
  return m;
}

/** Reset cached detection (for testing). */
export function resetDetection(): void {
  detectedManagers = null;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Look up the install hint for a command name.
 * Returns null if the command is not in the registry or no suitable
 * package manager is available.
 */
export function getInstallHint(command: string): InstallHint | null {
  const entry = INSTALL_REGISTRY[command];
  if (!entry) return null;

  const available = getAvailableManagers();

  // "system" entries — no auto-install, just suggest
  if (entry.manager === "system") {
    if (entry.command) {
      return { command: entry.command, packageName: entry.pkg, manager: "system" };
    }
    return { command: `Install "${entry.pkg}" using your system package manager`, packageName: entry.pkg, manager: "system" };
  }

  // "opam" — specialized
  if (entry.manager === "opam") {
    if (!available.has("opam")) return null;
    return { command: `opam install ${entry.pkg}`, packageName: entry.pkg, manager: "opam" };
  }

  if (!available.has(entry.manager)) {
    // Try fallback: pipx for pip packages
    if (entry.manager === "pip" && available.has("pipx")) {
      return { command: `pipx install ${entry.pkg}`, packageName: entry.pkg, manager: "pipx" };
    }
    return null;
  }

  const cmd = entry.command ?? buildInstallCommand(entry.manager, entry.pkg);
  return { command: cmd, packageName: entry.pkg, manager: entry.manager };
}

/**
 * Known commands without a registry entry still deserve an actionable hint.
 * `tsc` is the common one — bun projects (pico's own runtime) never need a
 * global tsc, so suggest the project-local install.
 */
const FALLBACK_INSTALL_HINTS: Record<string, string> = {
  tsc: "bun add -d typescript (or: npm install -g typescript)",
};

/** Get a user-friendly description of an install hint for display. */
export function formatInstallHint(command: string): string {
  const hint = getInstallHint(command);
  if (!hint) {
    const fallback = FALLBACK_INSTALL_HINTS[command];
    if (fallback) {
      return `Command "${command}" not found. Install it with:\n  ${fallback}`;
    }
    return `Command "${command}" not found. Install it with your package manager, or disable the server in ~/.pico/lsp.json.`;
  }
  return `Command "${command}" not found. Install it with:\n  ${hint.command}`;
}

/**
 * Execute the install command for a given LSP server command.
 * Returns { ok, output } where output contains stdout+stderr.
 */
export async function installServer(command: string): Promise<{ ok: boolean; output: string }> {
  const hint = getInstallHint(command);
  if (!hint) {
    return { ok: false, output: `No known install command for "${command}".` };
  }

  const [cmd, ...args] = hint.command.split(/\s+/)!;
  const result = spawnSync(cmd!, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    encoding: "utf8",
  });

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();

  return { ok: result.status === 0, output };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildInstallCommand(manager: PackageManager, pkg: string): string {
  switch (manager) {
    case "npm": return `npm install -g ${pkg}`;
    case "pip": return `pip install ${pkg}`;
    case "pipx": return `pipx install ${pkg}`;
    case "cargo": return `cargo install ${pkg}`;
    case "go": return `go install ${pkg}`;
    default: return `Install "${pkg}" manually`;
  }
}
