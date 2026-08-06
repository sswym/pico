import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import { askExtension } from "../extensions/ask/index.ts";
import { cacheOptimizerExtension } from "../extensions/cache-optimizer/index.ts";
import { doctorExtension } from "../extensions/doctor/index.ts";
import { hooksExtension } from "../extensions/hooks/index.ts";
import { initExtension } from "../extensions/init/index.ts";
import { inputHistoryExtension } from "../extensions/input-history/index.ts";
import { languageExtension } from "../extensions/language.ts";
import lspExtension from "../extensions/lsp/index.ts";
import { logoExtension } from "../extensions/logo/index.ts";
import { mcpExtension } from "../extensions/mcp/index.ts";
import { memoryExtension } from "../extensions/memory/index.ts";
import { observabilityExtension } from "../extensions/observability.ts";
import { planExtension } from "../extensions/plan/index.ts";
import { retroThemeExtension } from "../extensions/retro-theme/index.ts";
import { rtkExtension } from "../extensions/rtk/index.ts";
import skillExtension from "../extensions/skill/index.ts";
import subagentExtension from "../extensions/subagent/index.ts";
import { todoExtension } from "../extensions/todo/index.ts";
import { vibeExtension } from "../extensions/vibe.ts";
import { visionExtension } from "../extensions/vision/index.ts";
import { webExtension } from "../extensions/web/index.ts";

export type ExtensionPhase = "prompt" | "ui" | "tools" | "runtime" | "diagnostics";

export interface PicoExtension {
  name: string;
  factory: ExtensionFactory;
  phase: ExtensionPhase;
  dependsOn?: string[];
  safety?: {
    touchesFilesystem?: boolean;
    spawnsProcess?: boolean;
    usesNetwork?: boolean;
  };
}

export class ExtensionRegistry {
  readonly extensions: readonly PicoExtension[];

  constructor(extensions: readonly PicoExtension[]) {
    this.extensions = extensions;
    this.validate();
  }

  /**
   * Return named inline extensions so the upstream startup "Extensions"
   * listing shows nothing for pico's built-ins. Names still identify the
   * extension internally; `hidden: true` keeps the noisy `<inline:N>`
   * placeholder rows out of the startup panel (upstream renders hidden
   * inline extensions as `<inline:name>` otherwise).
   */
  factories(): InlineExtension[] {
    return this.extensions.map((extension) => ({
      name: extension.name,
      factory: extension.factory,
      hidden: true,
    }));
  }

  names(): string[] {
    return this.extensions.map((extension) => extension.name);
  }

  private validate(): void {
    const seen = new Set<string>();

    for (const extension of this.extensions) {
      if (seen.has(extension.name)) {
        throw new Error(`Duplicate pico extension registered: ${extension.name}`);
      }
      seen.add(extension.name);

      for (const dependency of extension.dependsOn ?? []) {
        if (!seen.has(dependency)) {
          throw new Error(`Extension ${extension.name} depends on ${dependency}, but it is not registered earlier`);
        }
      }
    }
  }
}

export const defaultExtensions = [
  { name: "vibe", factory: vibeExtension, phase: "prompt" },
  { name: "cache-optimizer", factory: cacheOptimizerExtension, phase: "prompt" },
  { name: "todo", factory: todoExtension, phase: "tools" },
  { name: "retro-theme", factory: retroThemeExtension, phase: "ui" },
  { name: "language", factory: languageExtension, phase: "prompt" },
  { name: "input-history", factory: inputHistoryExtension, phase: "ui" },
  { name: "logo", factory: logoExtension, phase: "ui", dependsOn: ["retro-theme"] },
  {
    name: "memory",
    factory: memoryExtension,
    phase: "tools",
    safety: { touchesFilesystem: true },
  },
  {
    name: "subagent",
    factory: subagentExtension,
    phase: "tools",
    safety: { touchesFilesystem: true, spawnsProcess: true },
  },
  {
    name: "skill",
    factory: skillExtension,
    phase: "tools",
    safety: { spawnsProcess: true },
    dependsOn: ["subagent"],
  },
  {
    name: "vision",
    factory: visionExtension,
    phase: "tools",
    safety: { touchesFilesystem: true, usesNetwork: true },
  },
  { name: "ask", factory: askExtension, phase: "tools" },
  {
    name: "init",
    factory: initExtension,
    phase: "tools",
    safety: { touchesFilesystem: true },
  },
  { name: "plan", factory: planExtension, phase: "tools" },
  { name: "web", factory: webExtension, phase: "tools", safety: { usesNetwork: true } },
  {
    name: "lsp",
    factory: lspExtension,
    phase: "tools",
    safety: { touchesFilesystem: true, spawnsProcess: true },
  },
  {
    name: "rtk",
    factory: rtkExtension,
    phase: "tools",
    safety: { spawnsProcess: true },
  },
  {
    name: "hooks",
    factory: hooksExtension,
    phase: "runtime",
    safety: { touchesFilesystem: true, spawnsProcess: true },
  },
  {
    name: "mcp",
    factory: mcpExtension,
    phase: "runtime",
    safety: { touchesFilesystem: true, spawnsProcess: true },
  },
  { name: "observability", factory: observabilityExtension, phase: "runtime" },
  { name: "doctor", factory: doctorExtension, phase: "diagnostics" },
] satisfies readonly PicoExtension[];

export function createDefaultExtensionRegistry(): ExtensionRegistry {
  return new ExtensionRegistry(defaultExtensions);
}
