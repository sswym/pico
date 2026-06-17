import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { decidePermission } from "./decide.ts";
import { permissionRuleValueToString } from "./parser.ts";
import { NO, permissionMessage, PERMISSION_TITLE, YES, YES_SESSION } from "./prompt.ts";
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
      description: "Show or clear srcode permission rules",
      handler: async (args, ctx) => {
        const cmd = args.trim().toLowerCase();
        store.reload(ctx.cwd || cwdFn());
        if (cmd === "clear-session") {
          store.clearSessionRules();
          ctx.ui.notify("Session permission rules cleared.", "info");
          return;
        }
        const lines = [
          `Mode: ${store.defaultMode()}`,
          "",
          formatRules(store),
          "",
          "Usage:",
          "  /permissions               — show loaded permission rules",
          "  /permissions clear-session — clear session-only rules",
        ];
        try {
          pi.sendMessage({ customType: "srcode.permissions", content: lines.join("\n"), display: true });
        } catch {
          console.log(lines.join("\n"));
        }
      },
    });
  };
}

export const permissionsExtension: ExtensionFactory = createPermissionsExtension();
export default permissionsExtension;

export { permissionMessage };
