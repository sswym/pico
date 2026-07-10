import type { MemoryProvider } from "./provider.ts";
import type { ProviderManager } from "./provider-manager.ts";
import { VALID_CATEGORIES, type Category, type Scope } from "./schema.ts";

export interface MemoryToolParams {
  action:
    | "add"
    | "search"
    | "probe"
    | "related"
    | "reason"
    | "contradict"
    | "list"
    | "update"
    | "remove"
    | "feedback";
  content?: string;
  query?: string;
  entity?: string;
  entities?: string[];
  fact_id?: number;
  category?: string;
  tags?: string;
  helpful?: boolean;
  min_trust?: number;
  limit?: number;
  scope?: string;
  correction_of?: number;
}

function jsonResult(payload: unknown) {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    details: payload,
  };
}

function errorResult(message: string) {
  const payload = { error: message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

function asCategory(raw: unknown): Category | undefined {
  if (typeof raw !== "string") return undefined;
  return (VALID_CATEGORIES as readonly string[]).includes(raw) ? (raw as Category) : undefined;
}

function parseScope(raw: unknown): Scope | undefined {
  return raw === "project" || raw === "global" ? raw : undefined;
}

function cwdForScope(scope: Scope | undefined, currentCwd: string | null): string | undefined {
  return scope === "project" ? (currentCwd ?? undefined) : undefined;
}

export function executeMemoryToolAction(
  params: MemoryToolParams,
  deps: {
    provider: MemoryProvider;
    manager: ProviderManager;
    currentCwd: string | null;
  },
) {
  const { provider, manager, currentCwd } = deps;

  try {
    switch (params.action) {
      case "add": {
        if (!params.content) return errorResult("'content' is required for add");
        const cat = asCategory(params.category);
        if (params.category && !cat) return errorResult(`invalid category '${params.category}'`);
        const scope = parseScope(params.scope);
        const beforeAdd = provider.onBeforeWrite?.({ action: "add", content: params.content, category: cat, scope, tags: params.tags, source: "manual" });
        if (beforeAdd && beforeAdd.ok === false) return errorResult(beforeAdd.reason ?? "memory write denied");
        const id = provider.add(params.content, {
          category: cat,
          tags: params.tags,
          scope,
          cwd: cwdForScope(scope, currentCwd),
          correctionOf: params.correction_of,
          source: "manual",
        });
        manager.notifyMemoryToolWrite({
          action: "add",
          content: params.content,
          tags: params.tags,
          category: cat,
          scope,
          source: "manual",
          factId: id,
        });
        const fact = provider.get(id);
        return jsonResult({ status: "added", fact_id: id, fact });
      }
      case "search": {
        if (!params.query) return errorResult("'query' is required for search");
        const cat = asCategory(params.category);
        const scope = parseScope(params.scope);
        const results = provider.search(params.query, {
          category: cat,
          minTrust: params.min_trust,
          limit: params.limit,
          scope,
          cwd: cwdForScope(scope, currentCwd),
        });
        return jsonResult({ count: results.length, results });
      }
      case "probe": {
        const target = params.entity ?? params.query;
        if (!target) return errorResult("'entity' is required for probe");
        const cat = asCategory(params.category);
        const scope = parseScope(params.scope);
        const results = provider.probe(target, {
          category: cat,
          minTrust: params.min_trust,
          limit: params.limit,
          scope,
          cwd: cwdForScope(scope, currentCwd),
        });
        return jsonResult({ count: results.length, results });
      }
      case "list": {
        const cat = asCategory(params.category);
        const scope = parseScope(params.scope);
        const results = provider.list({
          category: cat,
          minTrust: params.min_trust,
          limit: params.limit,
          scope,
          cwd: cwdForScope(scope, currentCwd),
        });
        return jsonResult({ count: results.length, facts: results });
      }
      case "related": {
        const target = params.entity ?? params.query;
        if (!target) return errorResult("'entity' is required for related");
        const cat = asCategory(params.category);
        const results = provider.related(target, {
          category: cat,
          minTrust: params.min_trust,
          limit: params.limit,
        });
        return jsonResult({ count: results.length, results });
      }
      case "reason": {
        if (!params.entities || params.entities.length === 0) return errorResult("'entities' list is required for reason");
        const cat = asCategory(params.category);
        const results = provider.reason(params.entities, {
          category: cat,
          minTrust: params.min_trust,
          limit: params.limit,
        });
        return jsonResult({ count: results.length, results });
      }
      case "contradict": {
        const cat = asCategory(params.category);
        const results = provider.contradict({
          category: cat,
          limit: params.limit,
        });
        return jsonResult({ count: results.length, contradictions: results });
      }
      case "update": {
        if (params.fact_id === undefined) return errorResult("'fact_id' is required for update");
        const cat = asCategory(params.category);
        if (params.category && !cat) return errorResult(`invalid category '${params.category}'`);
        const prevFact = provider.get(params.fact_id);
        const beforeUpd = provider.onBeforeWrite?.({ action: "update", content: params.content, factId: params.fact_id, category: cat, tags: params.tags, previousContent: prevFact?.content });
        if (beforeUpd && beforeUpd.ok === false) return errorResult(beforeUpd.reason ?? "memory write denied");
        const ok = provider.update(params.fact_id, {
          content: params.content,
          category: cat,
          tags: params.tags,
        });
        manager.notifyMemoryToolWrite({
          action: "update",
          content: params.content,
          tags: params.tags,
          category: cat,
          factId: params.fact_id,
          previousContent: prevFact?.content,
        });
        return jsonResult({ status: ok ? "updated" : "not_found", fact_id: params.fact_id });
      }
      case "remove": {
        if (params.fact_id === undefined) return errorResult("'fact_id' is required for remove");
        const beforeRm = provider.onBeforeWrite?.({ action: "remove", factId: params.fact_id });
        if (beforeRm && beforeRm.ok === false) return errorResult(beforeRm.reason ?? "memory write denied");
        const ok = provider.remove(params.fact_id);
        manager.notifyMemoryToolWrite({
          action: "remove",
          factId: params.fact_id,
        });
        return jsonResult({ status: ok ? "removed" : "not_found", fact_id: params.fact_id });
      }
      case "feedback": {
        if (params.fact_id === undefined) return errorResult("'fact_id' is required for feedback");
        if (params.helpful === undefined) return errorResult("'helpful' is required for feedback");
        const fact = provider.feedback(params.fact_id, params.helpful);
        if (!fact) return jsonResult({ status: "not_found", fact_id: params.fact_id });
        return jsonResult({ status: "ok", fact });
      }
    }
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
  return errorResult("unreachable");
}
