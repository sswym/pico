import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { decidePermission } from "./decide.ts";
import { permissionRuleValueToString } from "./parser.ts";
import { NO, permissionMessage, PERMISSION_TITLE, YES, YES_SESSION } from "./prompt.ts";
import { isPermissionMode, PERMISSION_MODES, type PermissionMode } from "./schema.ts";
import { PermissionStore } from "./store.ts";

function eventInput(event: ToolCallEvent): Record<string, unknown> {
  return (event.input ?? {}) as Record<string, unknown>;
}

function wholeToolRule(toolName: string): { toolName: string } {
  return { toolName };
}

function formatRules(store: PermissionStore): string {
  const rules = store.allRules();
  if (rules.length === 0) return "No permission rules loaded.";
  return rules
    .map((rule) => `- ${rule.behavior.padEnd(5)} ${permissionRuleValueToString(rule.value)} (${rule.source})`)
    .join("\n");
}

function formatMode(store: PermissionStore): string {
  const suffix = store.modeIsOverridden()
    ? ` (session override; configured ${store.configuredMode()})`
    : "";
  return `${store.defaultMode()}${suffix}`;
}

function modeUsage(): string {
  return [
    "Usage:",
    "  /permissions                    — show loaded permission rules",
    "  /permissions clear-session      — clear session-only rules",
    "  /permissions mode               — show current mode",
    "  /permissions mode <mode>        — set mode for this session",
    "  /permissions mode default-config — clear session mode override",
    "  /permissions cycle              — cycle mode for this session",
    "",
    `Modes: ${PERMISSION_MODES.join(", ")}`,
  ].join("\n");
}

function parseModeArg(arg: string): PermissionMode | undefined {
  return isPermissionMode(arg) ? arg : undefined;
}

function notifyMode(ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }, store: PermissionStore): void {
  ctx.ui.notify(`Permission mode: ${formatMode(store)}`, "info");
}

export function createPermissionsExtension(deps: { store?: PermissionStore; cwd?: () => string } = {}): ExtensionFactory {
  const store = deps.store ?? new PermissionStore();
  const cwdFn = deps.cwd ?? (() => process.cwd());

  return (pi: ExtensionAPI) => {
    store.reload(cwdFn());

    pi.on("tool_call", async (event, ctx) => {
      const cwd = ctx.cwd || cwdFn();
      store.reload(cwd);
      const decision = decidePermission(event.toolName, eventInput(event), cwd, store);

      if (decision.behavior === "allow") return {};
      if (decision.behavior === "deny") return { block: true, reason: decision.reason };

      if (!ctx.hasUI) {
        return { block: true, reason: `Permission required but no UI available: ${decision.reason}` };
      }

      const choice = await ctx.ui.select(
        `${PERMISSION_TITLE}\n${permissionMessage(event.toolName, decision.reason)}`,
        [YES, YES_SESSION, NO],
        { signal: ctx.signal, timeout: 120_000 },
      );

      if (choice === YES) return {};
      if (choice === YES_SESSION) {
        store.addSessionRule("allow", wholeToolRule(event.toolName), cwd);
        return {};
      }
      return { block: true, reason: `User denied ${event.toolName}: ${decision.reason}` };
    });

    pi.registerCommand("permissions", {
      description: "Show, clear, or change srcode permission rules",
      handler: async (args, ctx) => {
        const raw = args.trim();
        const [cmd = "", value = ""] = raw.split(/\s+/, 2);
        store.reload(ctx.cwd || cwdFn());

        if (cmd === "clear-session") {
          store.clearSessionRules();
          ctx.ui.notify("Session permission rules cleared.", "info");
          return;
        }

        if (cmd === "cycle") {
          store.cycleMode();
          notifyMode(ctx, store);
          return;
        }

        if (cmd === "mode") {
          if (!value) {
            notifyMode(ctx, store);
            return;
          }
          if (value === "default-config") {
            store.clearModeOverride();
            notifyMode(ctx, store);
            return;
          }
          const mode = parseModeArg(value);
          if (!mode) {
            ctx.ui.notify(`Unknown permission mode: ${value}`, "error");
            return;
          }
          store.setMode(mode);
          notifyMode(ctx, store);
          return;
        }

        if (raw.length > 0) {
          ctx.ui.notify(`Unknown /permissions command: ${raw}`, "warning");
        }

        const lines = [
          `Mode: ${formatMode(store)}`,
          "",
          formatRules(store),
          "",
          modeUsage(),
        ];
        try {
          pi.sendMessage({ customType: "srcode.permissions", content: lines.join("\n"), display: true });
        } catch {
          console.log(lines.join("\n"));
        }
      },
    });

    pi.registerShortcut("shift+tab", {
      description: "Cycle permission mode",
      handler: (ctx) => {
        store.reload(ctx.cwd || cwdFn());
        store.cycleMode();
        notifyMode(ctx, store);
      },
    });
  };
}

export const permissionsExtension: ExtensionFactory = createPermissionsExtension();
export default permissionsExtension;

export { permissionMessage };
