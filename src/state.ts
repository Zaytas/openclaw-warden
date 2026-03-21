import type { WardenState, SessionState } from './types.js';
import { extractSessionMeta } from './utils.js';

const GLOBAL_KEY = Symbol.for('openclaw.plugins.warden.state');
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

const globalRef = globalThis as typeof globalThis & {
  [key: symbol]: WardenState | undefined;
};

function createSessionState(): SessionState {
  return {
    editedFiles: new Set<string>(),
    taskToolCalls: 0,
    healthCheckRequired: false,
    healthCheckPassed: false,
    restartCommandInFlight: false,
    activeSubagents: 0,
    lastAccessedAt: Date.now(),
    isHeartbeatTurn: false,
  };
}

export function getGlobalState(): WardenState {
  let state = globalRef[GLOBAL_KEY];
  if (!state) {
    state = { sessions: new Map() };
    globalRef[GLOBAL_KEY] = state;
  }
  return state;
}

/**
 * Purge sessions that haven't been accessed in SESSION_TTL_MS.
 */
function purgeStale(global: WardenState): void {
  const now = Date.now();
  for (const [id, session] of global.sessions) {
    if (now - session.lastAccessedAt > SESSION_TTL_MS) {
      global.sessions.delete(id);
    }
  }
}

// ─── By-ID functions (primary) ───

export function getSessionStateById(sessionId: string): SessionState {
  const global = getGlobalState();
  purgeStale(global);
  let session = global.sessions.get(sessionId);
  if (!session) {
    session = createSessionState();
    global.sessions.set(sessionId, session);
  }
  session.lastAccessedAt = Date.now();
  return session;
}

export function resetSessionStateById(sessionId: string): SessionState {
  const global = getGlobalState();
  const session = createSessionState();
  global.sessions.set(sessionId, session);
  return session;
}

export function cleanupSessionById(sessionId: string): void {
  const global = getGlobalState();
  global.sessions.delete(sessionId);
}

// ─── Backward-compat ctx-based wrappers ───

export function getSessionState(ctx: Record<string, unknown>): SessionState {
  const meta = extractSessionMeta(ctx);
  return getSessionStateById(meta.sessionId);
}

export function resetSessionState(ctx: Record<string, unknown>): SessionState {
  const meta = extractSessionMeta(ctx);
  return resetSessionStateById(meta.sessionId);
}

export function cleanupSession(ctx: Record<string, unknown>): void {
  const meta = extractSessionMeta(ctx);
  cleanupSessionById(meta.sessionId);
}
