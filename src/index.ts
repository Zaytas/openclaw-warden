import type { WardenConfig, Rule, RuleContext, PluginApi } from './types.js';
import { getSessionState, resetSessionState, getSessionId, cleanupSession } from './state.js';
import { isSubagentContext } from './utils.js';
import { createFileEditLimitRule } from './rules/file-edit-limit.js';
import { createTaskToolLimitRule } from './rules/task-tool-limit.js';
import { createHealthCheckRule } from './rules/health-check.js';
import { createParallelFirstRule } from './rules/parallel-first.js';

export type { WardenConfig, Rule, RuleContext, PluginApi } from './types.js';
export type { SessionState, WardenState, BlockResult, PromptInjection } from './types.js';
export type {
  FileEditLimitConfig,
  TaskToolLimitConfig,
  HealthCheckConfig,
  ParallelFirstConfig,
} from './types.js';
export { cleanupSession } from './state.js';

const PREFIX = '[warden]';

const DEFAULT_CONFIG: WardenConfig = {
  enabled: true,
  fileEditLimit: {
    enabled: true,
    maxFiles: 2,
    tools: ['edit', 'write'],
  },
  taskToolLimit: {
    enabled: true,
    maxCalls: 2,
    tools: ['edit', 'write', 'exec', 'browser'],
  },
  healthCheck: {
    enabled: true,
    restartPatterns: [
      'docker restart',
      'docker compose restart',
      'docker-compose restart',
      'systemctl restart',
      'pm2 restart',
      'service restart',
    ],
    successPatterns: [
      'healthy',
      '"status":"ok"',
      '"status": "ok"',
      'health check passed',
      'is healthy',
      'is ready',
      'service is running',
      'started successfully',
    ],
    successStatusCodes: [200],
  },
  parallelFirst: {
    enabled: true,
    message:
      '🛡️ WARDEN: Before dispatching subagents, decompose the task into independent parallel workstreams. ' +
      'Identify which pieces of work have no dependencies on each other, then spawn ALL independent subagents simultaneously. ' +
      'Do not serialize work that can be parallelized. Plan first, then dispatch.',
  },
};

function mergeConfig(userConfig: Partial<WardenConfig> | undefined): WardenConfig {
  const cfg = { ...DEFAULT_CONFIG };
  if (!userConfig) return cfg;

  if (typeof userConfig.enabled === 'boolean') cfg.enabled = userConfig.enabled;

  if (userConfig.fileEditLimit) {
    cfg.fileEditLimit = { ...cfg.fileEditLimit, ...userConfig.fileEditLimit };
  }
  if (userConfig.taskToolLimit) {
    cfg.taskToolLimit = { ...cfg.taskToolLimit, ...userConfig.taskToolLimit };
  }
  if (userConfig.healthCheck) {
    cfg.healthCheck = { ...cfg.healthCheck, ...userConfig.healthCheck };
  }
  if (userConfig.parallelFirst) {
    cfg.parallelFirst = { ...cfg.parallelFirst, ...userConfig.parallelFirst };
  }

  return cfg;
}

function buildRuleContext(
  ctx: Record<string, unknown>,
  extra: { toolName?: string; toolParams?: Record<string, unknown>; toolResult?: unknown } = {},
): RuleContext {
  return {
    sessionId: getSessionId(ctx),
    sessionState: getSessionState(ctx),
    isSubagent: isSubagentContext(ctx),
    toolName: extra.toolName,
    toolParams: extra.toolParams,
    toolResult: extra.toolResult,
  };
}

function log(api: PluginApi, msg: string): void {
  const full = `${PREFIX} ${msg}`;
  if (api.logger?.info) {
    api.logger.info(full);
  } else {
    console.log(full);
  }
}

/**
 * Create a logger function scoped to a specific rule name.
 */
function makeRuleLogger(api: PluginApi, ruleName: string): (msg: string) => void {
  return (msg: string) => {
    const full = `[warden:${ruleName}] ${msg}`;
    if (api.logger?.info) {
      api.logger.info(full);
    } else {
      console.log(full);
    }
  };
}

export default function register(api: PluginApi): void {
  const config = mergeConfig(api.pluginConfig as Partial<WardenConfig> | undefined);

  if (!config.enabled) {
    log(api, 'Plugin disabled via config — skipping registration');
    return;
  }

  const rules: Rule[] = [
    createFileEditLimitRule(config.fileEditLimit, makeRuleLogger(api, 'file-edit-limit')),
    createTaskToolLimitRule(config.taskToolLimit, makeRuleLogger(api, 'task-tool-limit')),
    createHealthCheckRule(config.healthCheck, makeRuleLogger(api, 'health-check')),
    createParallelFirstRule(config.parallelFirst, makeRuleLogger(api, 'parallel-first')),
  ];

  const ruleNameToConfigKey: Record<string, keyof WardenConfig> = {
    'file-edit-limit': 'fileEditLimit',
    'task-tool-limit': 'taskToolLimit',
    'health-check': 'healthCheck',
    'parallel-first': 'parallelFirst',
  };

  const enabledRules = rules.filter((r) => {
    const configKey = ruleNameToConfigKey[r.name];
    if (!configKey) return true;
    const ruleConfig = config[configKey];
    return typeof ruleConfig === 'object' && ruleConfig !== null && 'enabled' in ruleConfig
      ? (ruleConfig as { enabled: boolean }).enabled
      : true;
  });

  // ─── before_agent_start ───
  api.on('before_agent_start', (_event, ctx) => {
    const ruleCtx = buildRuleContext(ctx as Record<string, unknown>);
    resetSessionState(ctx as Record<string, unknown>);
    // Re-fetch after reset
    const freshCtx = { ...ruleCtx, sessionState: getSessionState(ctx as Record<string, unknown>) };
    for (const rule of enabledRules) {
      rule.onSessionStart?.(freshCtx);
    }
  });

  // ─── before_tool_call ───
  api.on('before_tool_call', (event, ctx) => {
    const ev = event as Record<string, unknown>;
    const ruleCtx = buildRuleContext(ctx as Record<string, unknown>, {
      toolName: ev.toolName as string | undefined,
      toolParams: ev.params as Record<string, unknown> | undefined,
    });

    for (const rule of enabledRules) {
      const result = rule.onBeforeToolCall?.(ruleCtx);
      if (result?.block) {
        return result;
      }
    }
    return undefined;
  });

  // ─── after_tool_call ───
  api.on('after_tool_call', (event, ctx) => {
    const ev = event as Record<string, unknown>;
    const ruleCtx = buildRuleContext(ctx as Record<string, unknown>, {
      toolName: ev.toolName as string | undefined,
      toolParams: ev.params as Record<string, unknown> | undefined,
      toolResult: ev.result,
    });

    for (const rule of enabledRules) {
      rule.onAfterToolCall?.(ruleCtx);
    }
  });

  // ─── before_prompt_build ───
  api.on('before_prompt_build', (_event, ctx) => {
    const ruleCtx = buildRuleContext(ctx as Record<string, unknown>);
    const injections: string[] = [];

    for (const rule of enabledRules) {
      const injection = rule.onBeforePromptBuild?.(ruleCtx);
      if (injection?.text) {
        injections.push(injection.text);
      }
    }

    if (injections.length > 0) {
      return { appendSystemContext: injections.join('\n\n') };
    }
    return undefined;
  });

  // ─── subagent_spawned ───
  api.on('subagent_spawned', (_event, ctx) => {
    const ruleCtx = buildRuleContext(ctx as Record<string, unknown>);
    for (const rule of enabledRules) {
      rule.onSubagentSpawned?.(ruleCtx);
    }
  });

  // ─── subagent_ended ───
  api.on('subagent_ended', (_event, ctx) => {
    const ruleCtx = buildRuleContext(ctx as Record<string, unknown>);
    for (const rule of enabledRules) {
      rule.onSubagentEnded?.(ruleCtx);
    }
  });

  const ruleNames = enabledRules.map((r) => r.name).join(', ');
  log(api, `Registered with ${enabledRules.length} active rule(s): ${ruleNames}`);
}
