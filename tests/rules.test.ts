import { describe, it, expect, beforeEach } from 'vitest';
import type { RuleContext, SessionState, FileEditLimitConfig, TaskToolLimitConfig, HealthCheckConfig, ParallelFirstConfig } from '../src/types.js';
import { createFileEditLimitRule } from '../src/rules/file-edit-limit.js';
import { createTaskToolLimitRule } from '../src/rules/task-tool-limit.js';
import { createHealthCheckRule } from '../src/rules/health-check.js';
import { createParallelFirstRule } from '../src/rules/parallel-first.js';

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

// ─── file-edit-limit ───

describe('file-edit-limit', () => {
  const config: FileEditLimitConfig = {
    enabled: true,
    maxFiles: 2,
    tools: ['edit', 'write'],
  };

  it('allows edits up to maxFiles limit', () => {
    const rule = createFileEditLimitRule(config, noop);
    const ctx = makeCtx({ toolName: 'edit', toolParams: { file_path: '/a.ts' } });

    // First file — should be allowed
    const r1 = rule.onBeforeToolCall!(ctx);
    expect(r1).toBeUndefined();
    rule.onAfterToolCall!(ctx);

    // Second file — should be allowed
    ctx.toolParams = { file_path: '/b.ts' };
    const r2 = rule.onBeforeToolCall!(ctx);
    expect(r2).toBeUndefined();
    rule.onAfterToolCall!(ctx);

    expect(ctx.sessionState.editedFiles.size).toBe(2);
  });

  it('blocks edit when limit reached', () => {
    const rule = createFileEditLimitRule(config, noop);
    const ctx = makeCtx({ toolName: 'edit', toolParams: { file_path: '/a.ts' } });

    // Fill up to limit
    rule.onBeforeToolCall!(ctx);
    rule.onAfterToolCall!(ctx);
    ctx.toolParams = { file_path: '/b.ts' };
    rule.onBeforeToolCall!(ctx);
    rule.onAfterToolCall!(ctx);

    // Third file — should be blocked
    ctx.toolParams = { file_path: '/c.ts' };
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('File edit limit reached');
  });

  it('allows re-edits to same file (does not count as new)', () => {
    const rule = createFileEditLimitRule(config, noop);
    const ctx = makeCtx({ toolName: 'edit', toolParams: { file_path: '/a.ts' } });

    rule.onBeforeToolCall!(ctx);
    rule.onAfterToolCall!(ctx);
    ctx.toolParams = { file_path: '/b.ts' };
    rule.onBeforeToolCall!(ctx);
    rule.onAfterToolCall!(ctx);

    // Re-edit /a.ts — same file, should be allowed
    ctx.toolParams = { file_path: '/a.ts' };
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('skips subagent contexts', () => {
    const rule = createFileEditLimitRule(config, noop);
    const ctx = makeCtx({
      isSubagent: true,
      toolName: 'edit',
      toolParams: { file_path: '/a.ts' },
    });

    // Fill state manually to simulate limit
    ctx.sessionState.editedFiles = new Set(['/x.ts', '/y.ts']);

    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('tracks files in onAfterToolCall (not onBeforeToolCall)', () => {
    const rule = createFileEditLimitRule(config, noop);
    const ctx = makeCtx({ toolName: 'edit', toolParams: { file_path: '/a.ts' } });

    // Before call — file should not be tracked yet
    rule.onBeforeToolCall!(ctx);
    expect(ctx.sessionState.editedFiles.size).toBe(0);

    // After call — file should be tracked
    rule.onAfterToolCall!(ctx);
    expect(ctx.sessionState.editedFiles.size).toBe(1);
    expect(ctx.sessionState.editedFiles.has('/a.ts')).toBe(true);
  });
});

// ─── task-tool-limit ───

describe('task-tool-limit', () => {
  const config: TaskToolLimitConfig = {
    enabled: true,
    maxCalls: 2,
    tools: ['edit', 'write', 'exec'],
  };

  it('allows calls up to maxCalls limit', () => {
    const rule = createTaskToolLimitRule(config, noop);
    const ctx = makeCtx({ toolName: 'exec', toolParams: { command: 'ls' } });

    const r1 = rule.onBeforeToolCall!(ctx);
    expect(r1).toBeUndefined();
    expect(ctx.sessionState.taskToolCalls).toBe(1);

    const r2 = rule.onBeforeToolCall!(ctx);
    expect(r2).toBeUndefined();
    expect(ctx.sessionState.taskToolCalls).toBe(2);
  });

  it('blocks when limit reached', () => {
    const rule = createTaskToolLimitRule(config, noop);
    const ctx = makeCtx({ toolName: 'exec', toolParams: { command: 'ls' } });

    rule.onBeforeToolCall!(ctx);
    rule.onBeforeToolCall!(ctx);

    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('Task tool call limit reached');
  });

  it('only counts configured tool names', () => {
    const rule = createTaskToolLimitRule(config, noop);
    const ctx = makeCtx({ toolName: 'read', toolParams: {} });

    // 'read' is not in the configured tools
    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
    expect(ctx.sessionState.taskToolCalls).toBe(0);
  });

  it('skips subagent contexts', () => {
    const rule = createTaskToolLimitRule(config, noop);
    const ctx = makeCtx({
      isSubagent: true,
      toolName: 'exec',
      toolParams: { command: 'ls' },
    });

    ctx.sessionState.taskToolCalls = 100;

    const result = rule.onBeforeToolCall!(ctx);
    expect(result).toBeUndefined();
  });

  it('counter does not increment on blocked calls', () => {
    const rule = createTaskToolLimitRule(config, noop);
    const ctx = makeCtx({ toolName: 'exec', toolParams: { command: 'ls' } });

    rule.onBeforeToolCall!(ctx); // 1
    rule.onBeforeToolCall!(ctx); // 2

    // This should block, counter stays at 2
    const blocked = rule.onBeforeToolCall!(ctx);
    expect(blocked!.block).toBe(true);
    expect(ctx.sessionState.taskToolCalls).toBe(2);

    // Try again — still blocked, still 2
    const blocked2 = rule.onBeforeToolCall!(ctx);
    expect(blocked2!.block).toBe(true);
    expect(ctx.sessionState.taskToolCalls).toBe(2);
  });
});

// ─── health-check ───

describe('health-check', () => {
  const config: HealthCheckConfig = {
    enabled: true,
    restartPatterns: [
      'docker restart',
      'systemctl restart',
    ],
    successPatterns: [
      'healthy',
      '"status":"ok"',
      'service is running',
    ],
    successStatusCodes: [200],
  };

  it('detects restart patterns in exec commands', () => {
    const rule = createHealthCheckRule(config, noop);
    const ctx = makeCtx({
      toolName: 'exec',
      toolParams: { command: 'docker restart my-container' },
    });

    rule.onBeforeToolCall!(ctx);
    expect(ctx.sessionState.healthCheckRequired).toBe(true);
    expect(ctx.sessionState.restartCommandInFlight).toBe(true);
  });

  it('ignores restart command own output (restartCommandInFlight)', () => {
    const rule = createHealthCheckRule(config, noop);
    const ctx = makeCtx({
      toolName: 'exec',
      toolParams: { command: 'docker restart my-container' },
    });

    // Trigger restart detection
    rule.onBeforeToolCall!(ctx);
    expect(ctx.sessionState.restartCommandInFlight).toBe(true);

    // The restart command's own result — should be ignored
    ctx.toolResult = { output: 'my-container\nhealthy' };
    rule.onAfterToolCall!(ctx);
    expect(ctx.sessionState.restartCommandInFlight).toBe(false);
    expect(ctx.sessionState.healthCheckPassed).toBe(false);
  });

  it('recognizes success patterns in follow-up exec results', () => {
    const rule = createHealthCheckRule(config, noop);
    const ctx = makeCtx({
      toolName: 'exec',
      toolParams: { command: 'docker restart my-container' },
    });

    // Trigger restart
    rule.onBeforeToolCall!(ctx);
    // Clear the in-flight flag (simulate the restart result)
    ctx.toolResult = { output: 'my-container' };
    rule.onAfterToolCall!(ctx);

    // Follow-up exec with health check result
    ctx.toolParams = { command: 'curl http://localhost/health' };
    ctx.toolResult = { output: 'service is running and healthy' };
    rule.onAfterToolCall!(ctx);
    expect(ctx.sessionState.healthCheckPassed).toBe(true);
  });

  it('recognizes status code patterns', () => {
    const rule = createHealthCheckRule(config, noop);
    const ctx = makeCtx({
      toolName: 'exec',
      toolParams: { command: 'systemctl restart nginx' },
    });

    rule.onBeforeToolCall!(ctx);
    // Clear in-flight
    ctx.toolResult = { output: 'restarting...' };
    rule.onAfterToolCall!(ctx);

    // Health check with HTTP status code
    ctx.toolParams = { command: 'curl -I http://localhost' };
    ctx.toolResult = { output: 'HTTP/1.1 200 OK\nContent-Type: text/html' };
    rule.onAfterToolCall!(ctx);
    expect(ctx.sessionState.healthCheckPassed).toBe(true);
  });

  it('only scans exec tool results (not other tools)', () => {
    const rule = createHealthCheckRule(config, noop);
    const ctx = makeCtx({
      toolName: 'exec',
      toolParams: { command: 'docker restart app' },
    });

    // Trigger restart detection
    rule.onBeforeToolCall!(ctx);
    // Clear in-flight
    ctx.toolResult = { output: 'app' };
    rule.onAfterToolCall!(ctx);

    // Non-exec tool with success pattern — should NOT pass health check
    ctx.toolName = 'read';
    ctx.toolResult = { output: 'service is running' };
    rule.onAfterToolCall!(ctx);
    expect(ctx.sessionState.healthCheckPassed).toBe(false);
  });

  it('skips subagent contexts', () => {
    const rule = createHealthCheckRule(config, noop);
    const ctx = makeCtx({
      isSubagent: true,
      toolName: 'exec',
      toolParams: { command: 'docker restart app' },
    });

    rule.onBeforeToolCall!(ctx);
    expect(ctx.sessionState.healthCheckRequired).toBe(false);
  });

  it('returns prompt injection when health check pending', () => {
    const rule = createHealthCheckRule(config, noop);
    const ctx = makeCtx();
    ctx.sessionState.healthCheckRequired = true;
    ctx.sessionState.healthCheckPassed = false;

    const injection = rule.onBeforePromptBuild!(ctx);
    expect(injection).toBeDefined();
    expect(injection!.text).toContain('Health check required');
  });

  it('does not inject when health check already passed', () => {
    const rule = createHealthCheckRule(config, noop);
    const ctx = makeCtx();
    ctx.sessionState.healthCheckRequired = true;
    ctx.sessionState.healthCheckPassed = true;

    const injection = rule.onBeforePromptBuild!(ctx);
    expect(injection).toBeUndefined();
  });

  it('does not false-positive on partial status code matches', () => {
    // e.g., "status":2001 should NOT match 200
    const rule = createHealthCheckRule(config, noop);
    const ctx = makeCtx({ toolName: 'exec', toolParams: { command: 'systemctl restart nginx' } });
    rule.onBeforeToolCall!(ctx);
    ctx.toolResult = { output: 'restarting...' };
    rule.onAfterToolCall!(ctx);

    ctx.toolParams = { command: 'curl http://localhost/api' };
    ctx.toolResult = { output: '{"status":2001,"message":"processing"}' };
    rule.onAfterToolCall!(ctx);
    expect(ctx.sessionState.healthCheckPassed).toBe(false);
  });

  it('detects SysV-style service restart commands', () => {
    const rule = createHealthCheckRule(config, noop);
    const ctx = makeCtx({ toolName: 'exec', toolParams: { command: 'service nginx restart' } });
    rule.onBeforeToolCall!(ctx);
    expect(ctx.sessionState.healthCheckRequired).toBe(true);
  });
});

// ─── parallel-first ───

describe('parallel-first', () => {
  const config: ParallelFirstConfig = {
    enabled: true,
    message: 'Parallel dispatch guidance',
  };

  it('injects message when no active subagents', () => {
    const rule = createParallelFirstRule(config, noop);
    const ctx = makeCtx();
    ctx.sessionState.activeSubagents = 0;

    const injection = rule.onBeforePromptBuild!(ctx);
    expect(injection).toBeDefined();
    expect(injection!.text).toBe('Parallel dispatch guidance');
  });

  it('does not inject when subagents are active', () => {
    const rule = createParallelFirstRule(config, noop);
    const ctx = makeCtx();
    ctx.sessionState.activeSubagents = 2;

    const injection = rule.onBeforePromptBuild!(ctx);
    expect(injection).toBeUndefined();
  });

  it('tracks spawned subagents', () => {
    const rule = createParallelFirstRule(config, noop);
    const ctx = makeCtx();

    rule.onSubagentSpawned!(ctx);
    expect(ctx.sessionState.activeSubagents).toBe(1);

    rule.onSubagentSpawned!(ctx);
    expect(ctx.sessionState.activeSubagents).toBe(2);
  });

  it('tracks ended subagents', () => {
    const rule = createParallelFirstRule(config, noop);
    const ctx = makeCtx();
    ctx.sessionState.activeSubagents = 2;

    rule.onSubagentEnded!(ctx);
    expect(ctx.sessionState.activeSubagents).toBe(1);

    rule.onSubagentEnded!(ctx);
    expect(ctx.sessionState.activeSubagents).toBe(0);
  });

  it('does not go below zero on subagent end', () => {
    const rule = createParallelFirstRule(config, noop);
    const ctx = makeCtx();
    ctx.sessionState.activeSubagents = 0;

    rule.onSubagentEnded!(ctx);
    expect(ctx.sessionState.activeSubagents).toBe(0);
  });

  it('skips subagent contexts for spawned tracking', () => {
    const rule = createParallelFirstRule(config, noop);
    const ctx = makeCtx({ isSubagent: true });
    ctx.sessionState.activeSubagents = 0;

    rule.onSubagentSpawned!(ctx);
    expect(ctx.sessionState.activeSubagents).toBe(0);
  });

  it('skips subagent contexts for prompt injection', () => {
    const rule = createParallelFirstRule(config, noop);
    const ctx = makeCtx({ isSubagent: true });
    ctx.sessionState.activeSubagents = 0;

    const injection = rule.onBeforePromptBuild!(ctx);
    expect(injection).toBeUndefined();
  });
});
