import type { Rule, RuleContext, BlockResult, PromptInjection, HeartbeatQuietConfig } from '../types.js';

type LogFn = (msg: string) => void;

/**
 * Heartbeat-quiet rule.
 *
 * During heartbeat evaluation turns, blocks outbound `message` tool calls
 * that are just "nothing to report" noop messages. If the heartbeat finds
 * something real to report, those messages pass through.
 *
 * Fail-open: when uncertain, allow.
 *
 * Two hooks:
 * 1. onBeforePromptBuild — detect heartbeat turns via user message patterns
 * 2. onBeforeToolCall — block quiet message sends during heartbeat turns
 */
export function createHeartbeatQuietRule(config: HeartbeatQuietConfig, logger?: LogFn): Rule {
  const log: LogFn = logger ?? ((msg: string) => console.log(msg));

  // Pre-compile regex patterns for performance
  const heartbeatRegexes = config.heartbeatPatterns.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      log(`Invalid heartbeat pattern: ${p}`);
      return null;
    }
  }).filter((r): r is RegExp => r !== null);

  const actionableRegexes = config.actionablePatterns.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      log(`Invalid actionable pattern: ${p}`);
      return null;
    }
  }).filter((r): r is RegExp => r !== null);

  const quietRegexes = config.quietPatterns.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      log(`Invalid quiet pattern: ${p}`);
      return null;
    }
  }).filter((r): r is RegExp => r !== null);

  /**
   * Extract user message text from the event/context.
   * The before_prompt_build hook receives event and ctx — the user message
   * may appear in various locations depending on OpenClaw version.
   */
  function extractUserMessage(ctx: RuleContext): string | undefined {
    // The RuleContext doesn't directly carry the user message, but the
    // toolParams field is repurposed during prompt build to carry event data.
    // We check common locations where OpenClaw might place the user message.
    const params = ctx.toolParams as Record<string, unknown> | undefined;
    if (!params) return undefined;

    // Direct message field
    if (typeof params.message === 'string') return params.message;
    if (typeof params.userMessage === 'string') return params.userMessage;

    // Messages array (last user message)
    if (Array.isArray(params.messages)) {
      for (let i = params.messages.length - 1; i >= 0; i--) {
        const msg = params.messages[i] as Record<string, unknown> | undefined;
        if (msg && (msg.role === 'user' || !msg.role) && typeof msg.content === 'string') {
          return msg.content;
        }
      }
    }

    return undefined;
  }

  /**
   * Normalize text for quiet pattern matching: lowercase, strip emoji and
   * non-alphanumeric characters (keeping spaces).
   */
  function normalizeForQuietMatch(text: string): string {
    return text
      .toLowerCase()
      // Strip emoji (Unicode emoji ranges)
      .replace(/[\u{1F300}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, '')
      // Strip non-alphanumeric except spaces
      .replace(/[^a-z0-9\s]/g, ' ')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  return {
    name: 'heartbeat-quiet',

    onSessionStart(ctx: RuleContext): void {
      ctx.sessionState.isHeartbeatTurn = false;
    },

    onBeforePromptBuild(ctx: RuleContext): PromptInjection {
      if (!config.enabled) return undefined;

      // Reset at the beginning of each prompt build
      ctx.sessionState.isHeartbeatTurn = false;

      // Try to detect heartbeat turn from user message via toolParams
      const userMessage = extractUserMessage(ctx);
      if (userMessage) {
        for (const regex of heartbeatRegexes) {
          if (regex.test(userMessage)) {
            ctx.sessionState.isHeartbeatTurn = true;
            log(`Heartbeat turn detected via pattern: ${regex.source}`);
            break;
          }
        }
      }

      // This rule doesn't inject prompts
      return undefined;
    },

    onBeforeToolCall(ctx: RuleContext): BlockResult {
      if (!config.enabled) return undefined;

      // Only enforce during heartbeat turns
      if (!ctx.sessionState.isHeartbeatTurn) return undefined;

      // Only target the message tool
      if (ctx.toolName !== 'message') return undefined;

      const params = ctx.toolParams as Record<string, unknown> | undefined;
      if (!params) return undefined;

      // Only block send actions
      if (params.action !== 'send') return undefined;

      // If channels are configured, check if the target channel matches
      if (config.channels.length > 0) {
        const target = (params.target as string) ?? (params.channel as string) ?? '';
        const channelMatch = config.channels.some(
          (ch) => ch.toLowerCase() === target.toLowerCase(),
        );
        if (!channelMatch) return undefined;
      }

      // Extract message text
      const messageText =
        (typeof params.message === 'string' ? params.message : undefined) ??
        (typeof params.text === 'string' ? params.text : undefined) ??
        (typeof params.caption === 'string' ? params.caption : undefined);

      if (!messageText) {
        // No message text to evaluate — fail open
        return undefined;
      }

      // Stage 1: Check for actionable content — if ANY pattern matches, allow
      for (const regex of actionableRegexes) {
        if (regex.test(messageText)) {
          log(`Actionable content detected (${regex.source}) — allowing message`);
          return undefined;
        }
      }

      // Stage 2: Check for quiet/noop patterns — block if matched
      const normalized = normalizeForQuietMatch(messageText);
      for (const regex of quietRegexes) {
        // Test against both the original (lowercased) and normalized text
        if (regex.test(messageText.toLowerCase()) || regex.test(normalized)) {
          log(`Quiet heartbeat message blocked: "${messageText.substring(0, 80)}..."`);
          return {
            block: true,
            blockReason:
              '🛡️ WARDEN: Heartbeat found nothing actionable. Silence is the report. Reply HEARTBEAT_OK.',
          };
        }
      }

      // Default: fail open — allow if neither actionable nor quiet
      log(`Heartbeat message passed (fail-open): "${messageText.substring(0, 80)}..."`);
      return undefined;
    },
  };
}
