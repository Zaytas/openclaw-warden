import type { WardenState, SessionState } from './types.js';

const GLOBAL_KEY = Symbol.for('openclaw.plugins.warden.state');
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

let fallbackCounter = 0;
const fallbackIds = new WeakMap<object, string>();

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

export function getSessionId(ctx: Record<string, unknown>): string {
  if (typeof ctx.sessionId === 'string') return ctx.sessionId;
  if (typeof ctx.sessionKey === 'string') return ctx.sessionKey;
  const session = ctx.session as Record<string, unknown> | undefined;
  if (session) {
    if (typeof session.id === 'string') return session.id;
    if (typeof session.key === 'string') return session.key;
  }
  // Memoize fallback per context object so multiple calls with the same
  // ctx reference (e.g. buildRuleContext + getSessionState) return the same ID.
  let fallback = fallbackIds.get(ctx);
  if (!fallback) {
    fallback = `unknown-${++fallbackCounter}-${Date.now()}`;
    fallbackIds.set(ctx, fallback);
    console.warn(`[warden:state] No session ID found in context — using fallback: ${fallback}`);
  }
  return fallback;
}

export function getSessionState(ctx: Record<string, unknown>): SessionState {
  const id = getSessionId(ctx);
  const global = getGlobalState();

  // Opportunistically purge stale sessions
  purgeStale(global);

  let session = global.sessions.get(id);
  if (!session) {
    session = createSessionState();
    global.sessions.set(id, session);
  }
  session.lastAccessedAt = Date.now();
  return session;
}

export function resetSessionState(ctx: Record<string, unknown>): SessionState {
  const id = getSessionId(ctx);
  const global = getGlobalState();
  const session = createSessionState();
  global.sessions.set(id, session);
  return session;
}

/**
 * Remove a session from state. Call from subagent_ended or session cleanup hooks.
 */
export function cleanupSession(ctx: Record<string, unknown>): void {
  const id = getSessionId(ctx);
  const global = getGlobalState();
  global.sessions.delete(id);
}
