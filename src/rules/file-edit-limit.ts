import type { Rule, RuleContext, BlockResult, FileEditLimitConfig } from '../types.js';
import { normalizePathFromParams } from '../utils.js';

export function createFileEditLimitRule(
  config: FileEditLimitConfig,
  log: (msg: string) => void = console.log,
): Rule {
  return {
    name: 'file-edit-limit',

    onSessionStart(ctx: RuleContext): void {
      ctx.sessionState.editedFiles = new Set();
    },

    onBeforeToolCall(ctx: RuleContext): BlockResult {
      if (!config.enabled) return undefined;
      if (ctx.isSubagent) return undefined;
      if (!ctx.toolName || !config.tools.includes(ctx.toolName)) return undefined;

      const filePath = normalizePathFromParams((ctx.toolParams ?? {}) as Record<string, unknown>);
      if (!filePath) return undefined;

      // Already edited this file — allow continued edits to same file
      if (ctx.sessionState.editedFiles.has(filePath)) return undefined;

      if (ctx.sessionState.editedFiles.size >= config.maxFiles) {
        log(`Blocked: already edited ${config.maxFiles} distinct file(s) this turn`);
        return {
          block: true,
          blockReason:
            `🛡️ WARDEN: File edit limit reached — you've edited ${config.maxFiles} distinct file(s) this turn ` +
            `(${[...ctx.sessionState.editedFiles].join(', ')}). ` +
            `Delegate further file edits to a subagent, or reply to the user with your progress so far.`,
        };
      }

      // Don't track the file yet — wait for onAfterToolCall to confirm success
      return undefined;
    },

    onAfterToolCall(ctx: RuleContext): void {
      if (!config.enabled) return;
      if (ctx.isSubagent) return;
      if (!ctx.toolName || !config.tools.includes(ctx.toolName)) return;

      const filePath = normalizePathFromParams((ctx.toolParams ?? {}) as Record<string, unknown>);
      if (!filePath) return;

      if (!ctx.sessionState.editedFiles.has(filePath)) {
        ctx.sessionState.editedFiles.add(filePath);
        log(`Tracked file edit: ${filePath} (${ctx.sessionState.editedFiles.size}/${config.maxFiles})`);
      }
    },
  };
}
