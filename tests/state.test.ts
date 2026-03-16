import { describe, it, expect, beforeEach } from 'vitest';
import { getGlobalState, getSessionState, resetSessionState, cleanupSession, getSessionId } from '../src/state.js';

// Helper to create a minimal ctx object
function makeSessionCtx(id: string): Record<string, unknown> {
  return { sessionId: id };
}

describe('state management', () => {
  beforeEach(() => {
    // Clear all sessions before each test
    const global = getGlobalState();
    global.sessions.clear();
  });

  it('creates fresh session state', () => {
    const ctx = makeSessionCtx('fresh-1');
    const state = getSessionState(ctx);

    expect(state.editedFiles).toBeInstanceOf(Set);
    expect(state.editedFiles.size).toBe(0);
    expect(state.taskToolCalls).toBe(0);
    expect(state.healthCheckRequired).toBe(false);
    expect(state.healthCheckPassed).toBe(false);
    expect(state.restartCommandInFlight).toBe(false);
    expect(state.activeSubagents).toBe(0);
    expect(state.lastAccessedAt).toBeGreaterThan(0);
  });

  it('returns same state for same session ID', () => {
    const ctx = makeSessionCtx('same-id');
    const state1 = getSessionState(ctx);
    state1.taskToolCalls = 42;

    const state2 = getSessionState(ctx);
    expect(state2.taskToolCalls).toBe(42);
    expect(state1).toBe(state2);
  });

  it('resets session state', () => {
    const ctx = makeSessionCtx('reset-test');
    const state = getSessionState(ctx);
    state.taskToolCalls = 99;
    state.healthCheckRequired = true;

    const fresh = resetSessionState(ctx);
    expect(fresh.taskToolCalls).toBe(0);
    expect(fresh.healthCheckRequired).toBe(false);

    // Should still be retrievable
    const retrieved = getSessionState(ctx);
    expect(retrieved.taskToolCalls).toBe(0);
  });

  it('cleans up sessions', () => {
    const ctx = makeSessionCtx('cleanup-test');
    getSessionState(ctx);

    const global = getGlobalState();
    expect(global.sessions.has('cleanup-test')).toBe(true);

    cleanupSession(ctx);
    expect(global.sessions.has('cleanup-test')).toBe(false);
  });

  it('purges stale sessions', () => {
    const ctx1 = makeSessionCtx('stale-1');
    const ctx2 = makeSessionCtx('fresh-2');

    const state1 = getSessionState(ctx1);
    // Make it stale: set lastAccessedAt to 2 hours ago
    state1.lastAccessedAt = Date.now() - 2 * 60 * 60 * 1000;

    // Access a fresh session (triggers purge)
    getSessionState(ctx2);

    const global = getGlobalState();
    expect(global.sessions.has('stale-1')).toBe(false);
    expect(global.sessions.has('fresh-2')).toBe(true);
  });

  it('memoizes fallback session IDs for same context object', () => {
    // A context with no session id should generate a fallback
    const ctx: Record<string, unknown> = {};
    const id1 = getSessionId(ctx);
    expect(id1).toContain('unknown');

    // A different context object also gets a unique fallback
    const ctx2: Record<string, unknown> = {};
    const id2 = getSessionId(ctx2);
    expect(id2).toContain('unknown');
    expect(id1).not.toBe(id2);
  });
});
