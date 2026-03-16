import path from 'node:path';

/**
 * Detect whether the current context is a sub-agent session.
 */
export function isSubagentContext(ctx: Record<string, unknown>): boolean {
  if (ctx.isSubagent === true) return true;
  if (typeof ctx.parentSessionKey === 'string') return true;

  const session = ctx.session as Record<string, unknown> | undefined;
  if (session?.parentKey) return true;

  // Heuristic: session id contains "subagent"
  const id =
    (typeof ctx.sessionId === 'string' && ctx.sessionId) ||
    (typeof ctx.sessionKey === 'string' && ctx.sessionKey) ||
    (session && typeof session.id === 'string' && session.id) ||
    '';
  if (id.toLowerCase().includes('subagent')) return true;

  return false;
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
