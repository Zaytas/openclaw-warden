import { describe, it, expect, vi } from 'vitest';
import type { RuleContext, SpawnModelPolicyConfig } from '../src/types.js';
import { createSpawnModelPolicyRule } from '../src/rules/spawn-model-policy.js';

function makeCtx(overrides?: Partial<RuleContext>): RuleContext {
  return {
    sessionId: 'test-session',
    sessionState: {
      editedFiles: new Set(),
      taskToolCalls: 0,
      healthCheckRequired: false,
      healthCheckPassed: false,
      restartCommandInFlight: false,
      activeSubagents: 0,
      lastAccessedAt: Date.now(),
    },
    isSubagent: false,
    ...overrides,
  };
}

const noop = () => {};

const defaultConfig: SpawnModelPolicyConfig = {
  enabled: true,
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
};

describe('spawn-model-policy', () => {
  it('blocks spawn with no model for cheap task (missing model defaults to heavy)', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'ls -la in the directory' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('cheap');
  });

  it('allows cheap model for cheap task', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'cat the config file', model: 'claude-haiku' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('blocks heavy model for cheap task', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'ls all files', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('cheap');
  });

  it('allows heavy model for architecture task', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'design the new architecture for the system', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('blocks heavy model for mid-tier task', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'update the README with new instructions', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('mid');
  });

  it('allows mid model for mid-tier task', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'update the README with new instructions', model: 'claude-sonnet-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('heavy patterns override cheap patterns', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'review and grep the security policy', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('default tier when no patterns match', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'write a poem about cats', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('mid');
  });

  it('disabled rule allows everything', () => {
    const config = { ...defaultConfig, enabled: false };
    const rule = createSpawnModelPolicyRule(config, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'ls files', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('substring model matching with provider prefix (provider/claude-opus-4.6 matches opus)', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'ls files', model: 'provider/claude-opus-4.6' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it('case-insensitive task matching', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'run this command to cat a file', model: 'claude-haiku' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('unrecognized model treated as heavy (default unknownModelTier)', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'cat files', model: 'unknown-model-x' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it('non-sessions_spawn tools ignored', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'exec',
      toolParams: { command: 'ls' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  // ─── Regex and config validation ───

  it('invalid regex in config disables the rule gracefully', () => {
    const logMessages: string[] = [];
    const logger = (msg: string) => logMessages.push(msg);
    const config: SpawnModelPolicyConfig = {
      ...defaultConfig,
      cheapPatterns: ['[invalid(regex'],
    };
    const rule = createSpawnModelPolicyRule(config, logger);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'ls files', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
    expect(logMessages.some((m) => m.includes('ERROR') && m.includes('DISABLED'))).toBe(true);
  });

  it('overlapping model names: gpt-4o-mini is cheap, not mid (most specific wins)', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'cat a file', model: 'gpt-4o-mini' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  // ─── Annotation overrides ───

  it('task annotation [model-tier:heavy] allows heavy model', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'cat a file [model-tier:heavy]', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('task annotation [model-tier:cheap] blocks heavy model', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'design the architecture [model-tier:cheap]', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('cheap');
    expect(result!.blockReason).toContain('explicit annotation');
  });

  it('annotation is case-insensitive', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'do something [MODEL-TIER:Heavy]', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  // ─── Non-string params handling ───

  it('non-string task param treated as empty string', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 12345, model: 'claude-sonnet-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('non-string model param treated as undefined (missing model)', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'write a poem', model: 42 },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it('unknown model logs a warning', () => {
    const logMessages: string[] = [];
    const logger = (msg: string) => logMessages.push(msg);
    const rule = createSpawnModelPolicyRule(defaultConfig, logger);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'write a poem', model: 'mystery-model-9000' },
    });
    rule.onBeforeToolCall!(ctx);
    expect(logMessages.some((m) => m.includes('Warning: unknown model') && m.includes('mystery-model-9000'))).toBe(true);
  });

  // ─── Cheap pattern scope ───

  it('cheap patterns do not match destructive operations like rm', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'rm -rf the temp directory', model: 'claude-sonnet-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('heavy task classification: "check migration safety"', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'check migration safety', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  // ─── Configurable tier overrides ───

  it('configurable missingModelTier: set to cheap allows cheap tasks without model', () => {
    const config = { ...defaultConfig, missingModelTier: 'cheap' as const };
    const rule = createSpawnModelPolicyRule(config, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'cat a file' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('configurable unknownModelTier: set to mid treats unknown model as mid', () => {
    const config = { ...defaultConfig, unknownModelTier: 'mid' as const };
    const rule = createSpawnModelPolicyRule(config, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'write a poem', model: 'mystery-model' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  // ─── Deep merge and config edge cases ───

  it('partial tiers override preserves other tiers via deep merge', () => {
    const userOverride = { cheap: ['flash'] };
    const merged = {
      ...defaultConfig,
      tiers: {
        ...defaultConfig.tiers,
        ...userOverride,
      },
    };
    expect(merged.tiers.cheap).toEqual(['flash']);
    expect(merged.tiers.mid).toEqual(['sonnet', 'gpt-4o']);
    expect(merged.tiers.heavy).toEqual(['opus', 'gpt-5']);

    const rule = createSpawnModelPolicyRule(merged, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'cat a file', model: 'claude-haiku' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it('empty tier array produces clean block message without model suggestions', () => {
    const config: SpawnModelPolicyConfig = {
      ...defaultConfig,
      tiers: { cheap: [], mid: ['sonnet'], heavy: ['opus'] },
    };
    const rule = createSpawnModelPolicyRule(config, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'cat a file', model: 'claude-sonnet-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('Configure cheap-tier model patterns');
    expect(result!.blockReason).not.toContain('()');
  });

  it('empty string tier pattern is filtered out and does not match everything', () => {
    const logMessages: string[] = [];
    const logger = (msg: string) => logMessages.push(msg);
    const config: SpawnModelPolicyConfig = {
      ...defaultConfig,
      cheapPatterns: ['', '\\bls\\b'],
    };
    const rule = createSpawnModelPolicyRule(config, logger);
    expect(logMessages.some((m) => m.includes('empty string'))).toBe(true);

    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'write a poem', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('mid');
  });

  it('malformed config with non-array cheapPatterns disables rule', () => {
    const logMessages: string[] = [];
    const logger = (msg: string) => logMessages.push(msg);
    const config = {
      ...defaultConfig,
      cheapPatterns: 'not-an-array' as unknown as string[],
    };
    const rule = createSpawnModelPolicyRule(config, logger);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'ls files', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
    expect(logMessages.some((m) => m.includes('ERROR') && m.includes('DISABLED'))).toBe(true);
  });

  it('malformed config with non-array tiers.cheap disables rule', () => {
    const logMessages: string[] = [];
    const logger = (msg: string) => logMessages.push(msg);
    const config = {
      ...defaultConfig,
      tiers: { ...defaultConfig.tiers, cheap: 'not-an-array' as unknown as string[] },
    };
    const rule = createSpawnModelPolicyRule(config, logger);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'ls files', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
    expect(logMessages.some((m) => m.includes('ERROR') && m.includes('DISABLED'))).toBe(true);
  });

  // ─── Block message format ───

  it('block message includes escape hatch hint with model-tier annotation', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'cat a file', model: 'claude-opus-4' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.blockReason).toContain('[model-tier:heavy]');
    expect(result!.blockReason).toContain('Classification reason');
  });

  it('block message includes model tier info for mid-tier tasks', () => {
    const rule = createSpawnModelPolicyRule(defaultConfig, noop);
    const ctx = makeCtx({
      toolName: 'sessions_spawn',
      toolParams: { task: 'write some docs', model: 'provider/claude-opus-4.6' },
    });
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.blockReason).toContain('"mid" complexity');
    expect(result!.blockReason).toContain('"heavy" tier');
  });
});
