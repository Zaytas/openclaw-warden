import type { Rule, RuleContext, BlockResult, PromptInjection, HealthCheckConfig } from '../types.js';
import { commandFromParams, resultToText, matchesAnyPattern } from '../utils.js';

type LogFn = (msg: string) => void;

/**
 * Health-check guidance rule.
 *
 * This rule uses onBeforePromptBuild to inject a strong warning when a
 * service restart is detected but no health check has been confirmed.
 * Because the plugin API has no response-blocking hook, this is *prompt
 * guidance* — it steers the model but cannot enforce behaviour the way
 * onBeforeToolCall blocking can. The guidance is still valuable: it
 * detects restarts, scans exec output for health-check results, and
 * injects a clear warning so the agent doesn't prematurely report
 * success.
 *
 * @param config  HealthCheckConfig from warden settings
 * @param logger  Optional log function (falls back to console.log)
 */
export function createHealthCheckRule(config: HealthCheckConfig, logger?: LogFn): Rule {
  const log: LogFn = logger ?? ((msg: string) => console.log(msg));

  return {
    name: 'health-check',

    onSessionStart(ctx: RuleContext): void {
      ctx.sessionState.healthCheckRequired = false;
      ctx.sessionState.healthCheckPassed = false;
      ctx.sessionState.restartCommandInFlight = false;
    },

    onBeforeToolCall(ctx: RuleContext): BlockResult {
      if (!config.enabled) return undefined;
      if (ctx.isSubagent) return undefined;
      if (ctx.toolName !== 'exec') return undefined;

      const cmd = commandFromParams((ctx.toolParams ?? {}) as Record<string, unknown>);
      if (!cmd) return undefined;

      // Check configured restart patterns (substring matching)
      const matchesConfigured = matchesAnyPattern(cmd, config.restartPatterns);
      // Also catch SysV-style: "service <name> restart" where the service name
      // sits between "service" and "restart", so no single substring covers it.
      const matchesSysV = /\bservice\s+\S+\s+restart\b/i.test(cmd);

      if (matchesConfigured || matchesSysV) {
        log(`Restart command detected: ${cmd}`);
        ctx.sessionState.healthCheckRequired = true;
        ctx.sessionState.healthCheckPassed = false;
        // Flag so the restart command's own output isn't treated as a health check
        ctx.sessionState.restartCommandInFlight = true;
      }

      return undefined;
    },

    onAfterToolCall(ctx: RuleContext): void {
      if (!config.enabled) return;
      if (ctx.isSubagent) return;
      if (!ctx.sessionState.healthCheckRequired) return;
      if (ctx.sessionState.healthCheckPassed) return;

      // If this is the restart command's own result, clear the flag and skip
      if (ctx.sessionState.restartCommandInFlight) {
        ctx.sessionState.restartCommandInFlight = false;
        return;
      }

      // Only scan results from exec tool calls
      if (ctx.toolName !== 'exec') return;

      const text = resultToText(ctx.toolResult);
      if (!text) return;

      // Check for success patterns in the output
      if (matchesAnyPattern(text, config.successPatterns)) {
        log(`Health check passed — success pattern matched`);
        ctx.sessionState.healthCheckPassed = true;
        return;
      }

      // Check for status codes in the output with precise patterns
      for (const code of config.successStatusCodes) {
        const codePatterns = [
          `HTTP/1.1 ${code}`,
          `HTTP/2 ${code}`,
          `HTTP/1.0 ${code}`,
          `status_code: ${code}`,
          `"statusCode":${code}`,
          `"statusCode": ${code}`,
          `"status_code":${code}`,
          `"status_code": ${code}`,
          `"status":${code}`,
          `"status": ${code}`,
          `status=${code}`,
        ];
        if (matchesAnyPattern(text, codePatterns)) {
          log(`Health check passed — status code ${code} pattern matched`);
          ctx.sessionState.healthCheckPassed = true;
          return;
        }
      }
    },

    onBeforePromptBuild(ctx: RuleContext): PromptInjection {
      if (!config.enabled) return undefined;
      if (!ctx.sessionState.healthCheckRequired) return undefined;
      if (ctx.sessionState.healthCheckPassed) return undefined;

      return {
        text:
          '🛡️ WARDEN: Health check required — a service restart was detected but no successful health check has been confirmed yet. ' +
          'Do NOT tell the user the service is ready or suggest they refresh/retry. ' +
          'First, run a health check (e.g., curl the health endpoint, check service status, or verify logs) ' +
          'and confirm the service is actually healthy before reporting success. ' +
          'This is prompt-level guidance — no tool call will be blocked, but you MUST follow this instruction.',
      };
    },
  };
}
