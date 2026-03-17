import path from 'node:path';

export interface SessionMeta {
  sessionId: string;
  isSubagent: boolean;
  evidence: string[];
}

/**
 * Unified session metadata extraction.
 * Returns both session ID and subagent status from a single pass over the context,
 * ensuring both use the same field resolution order (including session.key).
 */
export function extractSessionMeta(ctx: Record<string, unknown>, fallbackCounter?: { count: number }): SessionMeta {
  const session = ctx.session as Record<string, unknown> | undefined;
  const evidence: string[] = [];

  // Direct flag from OpenClaw
  if (ctx.isSubagent === true) evidence.push('ctx.isSubagent=true');

  // Parent session linkage
  if (typeof ctx.parentSessionKey === 'string' && ctx.parentSessionKey) evidence.push('ctx.parentSessionKey');
  if (session?.parentKey) evidence.push('session.parentKey');

  // Resolve session ID — check ALL known paths including session.key
  const sessionId =
    (typeof ctx.sessionId === 'string' && ctx.sessionId) ||
    (typeof ctx.sessionKey === 'string' && ctx.sessionKey) ||
    (session && typeof session.key === 'string' && session.key) ||
    (session && typeof session.sessionKey === 'string' && session.sessionKey) ||
    (session && typeof session.id === 'string' && session.id) ||
    undefined;

  // Check if resolved ID contains subagent marker
  if (sessionId && sessionId.toLowerCase().includes('subagent')) {
    evidence.push('sessionId contains subagent');
  }

  // If we got a session ID, return it
  if (sessionId) {
    return { sessionId, isSubagent: evidence.length > 0, evidence };
  }

  // Fallback — unknown session, fail open (treat as subagent to avoid blocking)
  const fallbackId = fallbackCounter
    ? `unknown-${++fallbackCounter.count}-${Date.now()}`
    : `unknown-${Date.now()}`;

  // FAIL OPEN: if we can't identify the session at all, don't block it
  return { sessionId: fallbackId, isSubagent: true, evidence: ['unknown-session-fail-open'] };
}

/**
 * Extract a file path from tool call parameters and normalize to an absolute path.
 */
export function normalizePathFromParams(params: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'filePath']) {
    if (typeof params[key] === 'string') {
      return path.resolve(params[key] as string);
    }
  }
  return undefined;
}

/**
 * Extract a command string from exec-style tool parameters.
 */
export function commandFromParams(params: Record<string, unknown>): string | undefined {
  if (typeof params.command === 'string') return params.command;
  if (typeof params.cmd === 'string') return params.cmd;
  return undefined;
}

/**
 * Coerce a tool result to a plain string for pattern matching.
 */
export function resultToText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '';
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ['output', 'stdout', 'stderr', 'text', 'content', 'body']) {
      if (typeof obj[key] === 'string' && obj[key]) {
        parts.push(obj[key] as string);
      }
    }
    // Also include full JSON to catch numeric fields like statusCode
    try {
      parts.push(JSON.stringify(result));
    } catch {
      // ignore
    }
    return parts.join('\n');
  }
  return String(result);
}

/**
 * Check if text matches any pattern in a list (case-insensitive).
 * Patterns are treated as plain substrings.
 */
export function matchesAnyPattern(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}
