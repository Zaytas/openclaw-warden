import type { WardenConfig, Rule, RuleContext, PluginApi, BlockResult } from './types.js';
import { getSessionStateById, resetSessionStateById, cleanupSession } from './state.js';
import { extractSessionMeta } from './utils.js';
import { createFileEditLimitRule } from './rules/file-edit-limit.js';
import { createTaskToolLimitRule } from './rules/task-tool-limit.js';
import { createHealthCheckRule } from './rules/health-check.js';
import { createParallelFirstRule } from './rules/parallel-first.js';
import { createSpawnModelPolicyRule } from './rules/spawn-model-policy.js';

export type { WardenConfig, Rule, RuleContext, PluginApi } from './types.js';
export type { SessionState, WardenState, BlockResult, PromptInjection } from './types.js';
export type {
  FileEditLimitConfig,
  TaskToolLimitConfig,
  HealthCheckConfig,
  ParallelFirstConfig,
  SpawnModelPolicyConfig,
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
  spawnModelPolicy: {
    enabled: false,
    defaultTier: 'mid',
    missingModelTier: 'heavy',
    unknownModelTier: 'heavy',
    tiers: {
      cheap: ['haiku', 'gpt-4o-mini'],
      mid: ['sonnet', 'gpt-4o'],
      heavy: ['opus', 'gpt-5'],
    },
    cheapPatterns: [
      '\\b(ls|find|grep|cat|stat|wc|head|tail|echo|pwd|which|whoami|uptime|df|du|free|env|printenv|id|hostname|uname|date)\\b',
      '\\b(run this command|run these commands|single command|one command)\\b',
      '^(list files|show contents|read file|cat |grep |find |ls )',
    ],
    heavyPatterns: [
      '\\b(architect|architecture|design|tradeoff|trade-off|security|policy|review|audit|consult|consultant|complex|refactor|restructure|redesign|strategy|decision|doctrine|risk)\\b',
      '\\b(analyze|analysis|investigate|debug|diagnose|root.cause|performance|concurrency|migration|evaluate|comparison|compare|permissions|auth|authorization)\\b',
    ],
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
  if (userConfig.spawnModelPolicy) {
    const userSMP = userConfig.spawnModelPolicy;
    cfg.spawnModelPolicy = {
      ...cfg.spawnModelPolicy,
      ...userSMP,
      tiers: {
        ...cfg.spawnModelPolicy.tiers,
        ...(userSMP.tiers ?? {}),
      },
    };
  }

  return cfg;
}

function buildRuleContext(
  ctx: Record<string, unknown>,
  extra: { toolName?: string; toolParams?: Record<string, unknown>; toolResult?: unknown } = {},
): RuleContext {
  const meta = extractSessionMeta(ctx);
  return {
    sessionId: meta.sessionId,
    sessionState: getSessionStateById(meta.sessionId),
    isSubagent: meta.isSubagent,
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
    createTaskToolLimitRule(
      config.taskToolLimit,
      makeRuleLogger(api, 'task-tool-limit'),
      api.runtime?.subagent as Parameters<typeof createTaskToolLimitRule>[2],
    ),
    createHealthCheckRule(config.healthCheck, makeRuleLogger(api, 'health-check')),
    createParallelFirstRule(config.parallelFirst, makeRuleLogger(api, 'parallel-first')),
    createSpawnModelPolicyRule(config.spawnModelPolicy, makeRuleLogger(api, 'spawn-model-policy')),
  ];

  const ruleNameToConfigKey: Record<string, keyof WardenConfig> = {
    'file-edit-limit': 'fileEditLimit',
    'task-tool-limit': 'taskToolLimit',
    'health-check': 'healthCheck',
    'parallel-first': 'parallelFirst',
    'spawn-model-policy': 'spawnModelPolicy',
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
    const meta = extractSessionMeta(ctx as Record<string, unknown>);
    resetSessionStateById(meta.sessionId);
    const freshState = getSessionStateById(meta.sessionId);
    const ruleCtx: RuleContext = {
      sessionId: meta.sessionId,
      sessionState: freshState,
      isSubagent: meta.isSubagent,
    };
    for (const rule of enabledRules) {
      rule.onSessionStart?.(ruleCtx);
    }
  });

  // ─── before_tool_call ───
  api.on('before_tool_call', async (event, ctx) => {
    const ev = event as Record<string, unknown>;
    const ruleCtx = buildRuleContext(ctx as Record<string, unknown>, {
      toolName: ev.toolName as string | undefined,
      toolParams: ev.params as Record<string, unknown> | undefined,
    });

    if (ruleCtx.isSubagent) {
      log(api, `Subagent bypass: session=${ruleCtx.sessionId} tool=${ruleCtx.toolName}`);
    }

    for (const rule of enabledRules) {
      const rawResult = rule.onBeforeToolCall?.(ruleCtx);
      // Support both sync and async rule results
      const result: BlockResult = rawResult && typeof (rawResult as Promise<unknown>).then === 'function'
        ? await (rawResult as Promise<BlockResult>)
        : rawResult as BlockResult;
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
