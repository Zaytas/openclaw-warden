/**
 * Auto-Delegation Module
 *
 * When the warden blocks a tool call (e.g. task-tool-limit), this module attempts
 * to automatically spawn a subagent to continue the work — removing model discretion.
 *
 * Strategy:
 * 1. Try runtime.subagent.run() directly (works if OpenClaw wires up the real runtime)
 * 2. Fall back to enhanced blockReason with structured delegation instructions
 */

export interface AutoDelegateOptions {
  /** The tool that was blocked */
  toolName: string;
  /** Parameters of the blocked tool call */
  toolParams: Record<string, unknown>;
  /** Number of tool calls already made */
  callsMade: number;
  /** The configured limit */
  maxCalls: number;
  /** Which tools are tracked */
  trackedTools: string[];
  /** Optional model override for the spawned subagent */
  model?: string;
}

export interface SubagentRuntime {
  run(opts: SubagentRunOptions): Promise<SubagentRunResult>;
  waitForRun(runId: string): Promise<SubagentRunResult>;
  getSessionMessages(sessionKey: string): Promise<unknown[]>;
  getSession(sessionKey: string): Promise<unknown>;
  deleteSession(sessionKey: string): Promise<void>;
}

export interface SubagentRunOptions {
  task: string;
  runtime?: 'subagent';
  mode?: 'run' | 'session';
  model?: string;
}

export interface SubagentRunResult {
  runId?: string;
  sessionKey?: string;
  status?: string;
  [key: string]: unknown;
}

export interface AutoDelegateResult {
  /** Whether auto-delegation succeeded */
  success: boolean;
  /** The blockReason to return to the model */
  blockReason: string;
  /** Error message if delegation failed */
  error?: string;
  /** Run ID of the spawned subagent (if successful) */
  runId?: string;
}

/**
 * Build a task description for the subagent from the blocked tool call context.
 */
function buildSubagentTask(opts: AutoDelegateOptions): string {
  const paramsSummary = formatParams(opts.toolParams);

  return [
    `Continue the parent session's work. The warden blocked a tool call after ${opts.callsMade} calls ` +
      `(limit: ${opts.maxCalls} for ${opts.trackedTools.join('/')}).`,
    '',
    `## Blocked Tool Call`,
    `Tool: ${opts.toolName}`,
    `Parameters:`,
    paramsSummary,
    '',
    `Execute the blocked tool call above, then continue any remaining work from the parent session context.`,
    `You have full tool access as a subagent — the per-turn limit does not apply to you.`,
  ].join('\n');
}

/**
 * Format tool params for inclusion in the task description.
 * Truncates very large values to keep the task reasonable.
 */
function formatParams(params: Record<string, unknown>): string {
  const MAX_VALUE_LENGTH = 2000;
  const lines: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    let formatted: string;
    if (typeof value === 'string') {
      formatted = value.length > MAX_VALUE_LENGTH
        ? value.substring(0, MAX_VALUE_LENGTH) + `... [truncated, ${value.length} chars total]`
        : value;
    } else {
      const json = JSON.stringify(value, null, 2);
      formatted = json.length > MAX_VALUE_LENGTH
        ? json.substring(0, MAX_VALUE_LENGTH) + `... [truncated]`
        : json;
    }
    lines.push(`  ${key}: ${formatted}`);
  }

  return lines.join('\n');
}

/**
 * Attempt to auto-delegate a blocked tool call to a subagent.
 *
 * Tries runtime.subagent.run() first; if unavailable or it fails,
 * falls back to a structured blockReason that instructs the model to delegate.
 */
export async function autoDelegate(
  runtime: SubagentRuntime | undefined,
  opts: AutoDelegateOptions,
  log: (msg: string) => void,
): Promise<AutoDelegateResult> {
  const task = buildSubagentTask(opts);

  // ─── Attempt 1: Direct runtime spawn ───
  if (runtime && typeof runtime.run === 'function') {
    try {
      const runOpts: SubagentRunOptions = {
        task,
        runtime: 'subagent',
        mode: 'run',
        ...(opts.model ? { model: opts.model } : {}),
      };

      log(`Attempting auto-delegation via runtime.subagent.run() for blocked ${opts.toolName}`);
      const result = await runtime.run(runOpts);
      const runId = result?.runId ?? 'unknown';

      log(`Auto-delegation SUCCESS: runId=${runId}`);

      return {
        success: true,
        runId: String(runId),
        blockReason:
          `🛡️ WARDEN: Tool call limit reached (${opts.callsMade}/${opts.maxCalls} calls to ${opts.trackedTools.join('/')}). ` +
          `A subagent has been automatically spawned to handle the blocked operation (runId: ${runId}). ` +
          `You do not need to delegate — it's already handled. ` +
          `Wait for the subagent to complete, or continue with your response.`,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Auto-delegation via runtime.subagent.run() failed: ${errMsg}`);
      // Fall through to fallback
    }
  } else {
    log(`runtime.subagent.run not available (stub or missing) — using fallback delegation message`);
  }

  // ─── Fallback: Enhanced blockReason with structured delegation ───
  const paramsJson = safeStringify(opts.toolParams);

  return {
    success: false,
    error: runtime ? 'runtime.subagent.run() threw an error' : 'runtime.subagent not available',
    blockReason:
      `🛡️ WARDEN: Task tool call limit reached — ${opts.maxCalls} calls to ${opts.trackedTools.join('/')} per turn. ` +
      `You've already made ${opts.callsMade} task tool call(s). ` +
      `You MUST delegate continuation to a subagent NOW. Do NOT reply with text instead.\n\n` +
      `## Blocked Call Details\n` +
      `Tool: ${opts.toolName}\n` +
      `Params: ${paramsJson}\n\n` +
      `Spawn a subagent with this task: execute the blocked ${opts.toolName} call above and continue any remaining work.\n\n` +
      `Direct reply is allowed ONLY if: (1) the task is already complete and only the final user-facing message remains, ` +
      `or (2) further progress requires new user input or approval that no subagent can obtain.`,
  };
}

function safeStringify(obj: unknown): string {
  try {
    const json = JSON.stringify(obj, null, 2);
    return json.length > 3000 ? json.substring(0, 3000) + '\n... [truncated]' : json;
  } catch {
    return '[unable to serialize params]';
  }
}
