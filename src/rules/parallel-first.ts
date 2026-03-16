import type { Rule, RuleContext, PromptInjection, ParallelFirstConfig } from '../types.js';

export function createParallelFirstRule(
  config: ParallelFirstConfig,
  log: (msg: string) => void = console.log,
): Rule {
  return {
    name: 'parallel-first',

    onSubagentSpawned(ctx: RuleContext): void {
      // Only track on the parent session, not the subagent's own session
      if (ctx.isSubagent) return;
      ctx.sessionState.activeSubagents++;
      log(`Subagent spawned — active: ${ctx.sessionState.activeSubagents}`);
    },

    onSubagentEnded(ctx: RuleContext): void {
      // Only track on the parent session, not the subagent's own session
      if (ctx.isSubagent) return;
      ctx.sessionState.activeSubagents = Math.max(0, ctx.sessionState.activeSubagents - 1);
      log(`Subagent ended — active: ${ctx.sessionState.activeSubagents}`);
    },

    onBeforePromptBuild(ctx: RuleContext): PromptInjection {
      if (!config.enabled) return undefined;
      if (ctx.isSubagent) return undefined;
      if (ctx.sessionState.activeSubagents > 0) return undefined;

      return { text: config.message };
    },
  };
}
