import type { AgentConfig } from "./agents.ts";
import { isFailedResult, type SingleResult } from "./results.ts";

const PROVIDER_FAILURE_PATTERN =
	/rate[\s._-]?limit|overloaded|503|429|529|capacity|quota|insufficient_quota|401|403|unauthorized|authentication|auth[\s._-]?fail|context[\s._-]?(length|window)|contextWindow/i;

export function isProviderFailure(result: SingleResult): boolean {
	return result.stopReason === "error" && PROVIDER_FAILURE_PATTERN.test(result.errorMessage || "");
}

export interface FallbackRunRequest<TContext> {
	agents: AgentConfig[];
	agentName: string;
	context: TContext;
	signal?: AbortSignal;
	run: (agents: AgentConfig[], context: TContext) => Promise<SingleResult>;
	onSuccessOrNoFallback: (agent: AgentConfig | undefined, result: SingleResult) => Promise<SingleResult>;
}

export async function runWithFallbackModels<TContext>(
	request: FallbackRunRequest<TContext>,
): Promise<SingleResult> {
	const agent = request.agents.find((a) => a.name === request.agentName);
	const result = await request.run(request.agents, request.context);

	if (!isFailedResult(result) || !agent?.fallbackModels?.length) {
		return await request.onSuccessOrNoFallback(agent, result);
	}

	if (!isProviderFailure(result)) return result;

  for (const fallbackModel of agent.fallbackModels) {
    if (request.signal?.aborted) break;
    const fallbackAgent = { ...agent, model: fallbackModel, fallbackModels: undefined };
    const fallbackAgents = request.agents.map((a) => a.name === request.agentName ? fallbackAgent : a);
    const fallbackResult = await request.run(fallbackAgents, request.context);
    if (!isFailedResult(fallbackResult)) {
      // A fallback-model success must still pass the acceptance gate —
      // skipping onSuccessOrNoFallback here would let unverified output
      // through whenever the primary model failed.
      return await request.onSuccessOrNoFallback(fallbackAgent, fallbackResult);
    }
  }

  return result;
}
