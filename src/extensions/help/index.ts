/**
 * Help extension — offline /help command + unknown-slash-command guidance.
 *
 * Two problems this solves (found in TUI testing):
 * 1. "/help" was not registered anywhere (pico docs claimed it, upstream
 *    only ships /hotkeys), so typing /help burned an LLM round-trip and the
 *    model answered from memory — with visible hallucinations about which
 *    commands actually exist.
 * 2. Unknown slash commands (/foobar) fell through to the LLM as ordinary
 *    messages; the model then spent tokens guessing what the user meant.
 *    Upstream's input dispatcher has no unknown-command branch, so pico
 *    intercepts at the context event: before the LLM call we detect a
 *    "/"-prefixed user message that matches no registered command and inject
 *    a system message telling the model to answer in one line and point at
 *    /help — no guessing, no hallucinated command semantics.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Minimal shape of pi.getCommands() entries (SlashCommandInfo). */
export interface SlashCommandInfo {
  name: string;
  description?: string;
}

/**
 * Built-in slash commands shipped by upstream pi (slash-commands.js). These
 * are NOT returned by pi.getCommands() — that only lists extension commands.
 * Keep in sync when upstream adds/removes builtins; /help is the offline
 * source of truth for users, and the context guard uses this to avoid
 * flagging legitimate builtins as unknown.
 */
export const BUILTIN_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or path: .html/.jsonl)" },
  { name: "import", description: "Import and resume a session from a JSONL file" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
  { name: "quit", description: "Quit pico" },
];

export const KEYBOARD_SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: "Esc", description: "中断当前任务（agent 运行中）" },
  { keys: "Ctrl+D", description: "退出（输入框为空时）" },
  { keys: "Ctrl+C", description: "清空输入框" },
  { keys: "Ctrl+V", description: "粘贴图片或文本" },
  { keys: "Ctrl+O", description: "展开/折叠工具输出" },
  { keys: "! / !!", description: "运行 bash 命令（!! 不进上下文）" },
  { keys: "F7", description: "折叠/展开 todo 面板" },
];

/** Offline help text: builtins + extension commands + shortcuts. */
export function buildHelpText(extensionCommands: SlashCommandInfo[]): string {
  const lines: string[] = [];
  lines.push("pico 命令速查（离线）");
  lines.push("");
  lines.push("pico 扩展命令：");
  if (extensionCommands.length === 0) {
    lines.push("  （无）");
  } else {
    for (const cmd of extensionCommands) {
      lines.push(`  /${cmd.name}${cmd.description ? `  ${cmd.description}` : ""}`);
    }
  }
  lines.push("");
  lines.push("上游内置命令：");
  lines.push("  " + BUILTIN_COMMANDS.map((c) => `/${c.name}`).join("  "));
  lines.push("");
  lines.push("快捷键：");
  for (const shortcut of KEYBOARD_SHORTCUTS) {
    lines.push(`  ${shortcut.keys.padEnd(8)} ${shortcut.description}`);
  }
  lines.push("");
  lines.push("说明：");
  lines.push("  /quit 退出 pico。以 / 开头但未在上表列出的输入会被当作普通消息发送给模型；");
  lines.push("  输入 /help 可随时查看本表。");
  return lines.join("\n");
}

/** Extract the plain-text content of a user message, or "" when absent. */
function extractUserText(message: { role?: string; content?: unknown }): string {
  if (message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join(" ");
  }
  return "";
}

/** Guidance text for unknown "/cmd" inputs. Rides a user-role message
 *  (AgentMessage has no system role; the LLM converter drops unknown roles). */
export function buildUnknownCommandGuidance(commandName: string): string {
  return (
    `[pico 系统提示：以下不是用户的新请求，而是 pico 注入的说明] ` +
    `用户最新消息以 "/" 开头，但 "${commandName}" 不是已注册命令（可能拼写错误）。` +
    `请用一句话告知用户这不是有效命令，并引导其输入 /help 查看全部命令与快捷键；` +
    `不要猜测、解释或编造该命令的用途。`
  );
}

export const helpExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerCommand("help", {
    description: "Show pico commands and keyboard shortcuts (offline)",
    handler: async (_args, ctx) => {
      const text = buildHelpText(pi.getCommands());
      if (ctx.hasUI) {
        pi.sendMessage({ customType: "pico.help", content: text, display: true });
        return;
      }
      // Non-interactive (--print / CI): the custom-message channel goes
      // nowhere — emit on stdout instead of silently doing nothing.
      try {
        console.log(text);
      } catch {}
    },
  });

  // Unknown-slash-command guard: inject guidance once per distinct command
  // name. Only fires when the message survived template/skill expansion with
  // a leading "/" — i.e. it is not a known prompt template or skill command.
  const guidedCommandNames = new Set<string>();
  pi.on("context", (event) => {
    const messages = event.messages;
    if (!messages || messages.length === 0) return;
    const last = messages[messages.length - 1];
    const text = extractUserText(last as { role?: string; content?: unknown });
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("/")) return;

    const commandName = trimmed.slice(1).split(/\s+/)[0] ?? "";
    if (!commandName || guidedCommandNames.has(commandName)) return;

    const known = new Set<string>([
      ...BUILTIN_COMMANDS.map((c) => c.name),
      ...pi.getCommands().map((c) => c.name),
    ]);
    if (known.has(commandName)) return;

    guidedCommandNames.add(commandName);
    messages.push({
      role: "user",
      content: [{ type: "text", text: buildUnknownCommandGuidance(commandName) }],
      timestamp: Date.now(),
    });
    return { messages };
  });
};
