import type { Rule, RuleContext, BlockResult, TaskToolLimitConfig } from '../types.js';

export function createTaskToolLimitRule(
  config: TaskToolLimitConfig,
  log: (msg: string) => void = console.log,
): Rule {
  return {
    name: 'task-tool-limit',

    onSessionStart(ctx: RuleContext): void {
      ctx.sessionState.taskToolCalls = 0;
    },

    onBeforeToolCall(ctx: RuleContext): BlockResult {
      if (!config.enabled) return undefined;
      if (ctx.isSubagent) return undefined;
      if (!ctx.toolName || !config.tools.includes(ctx.toolName)) return undefined;

      // Check BEFORE incrementing — only count calls that are allowed through
      if (ctx.sessionState.taskToolCalls >= config.maxCalls) {
        log(`Blocked: ${ctx.sessionState.taskToolCalls} task tool calls meets/exceeds limit of ${config.maxCalls}`);
        return {
          block: true,
          blockReason:
            `🛡️ WARDEN: Task tool call limit reached — ${config.maxCalls} calls to ${config.tools.join('/')} per turn. ` +
            `You've already made ${ctx.sessionState.taskToolCalls} task tool call(s). ` +
            `If unfinished tool-dependent work remains, you MUST delegate continuation to a subagent. ` +
            `Direct reply is allowed ONLY if: (1) the task is already complete and only the final user-facing message remains, ` +
            `or (2) further progress requires new user input or approval that no subagent can obtain.`,
        };
      }

      // Increment only when the call will be allowed through
      ctx.sessionState.taskToolCalls++;
      return undefined;
    },
  };
}
