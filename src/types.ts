// ─── Configuration Types ───

export interface FileEditLimitConfig {
  enabled: boolean;
  maxFiles: number;
  tools: string[];
}

export interface TaskToolLimitConfig {
  enabled: boolean;
  maxCalls: number;
  tools: string[];
  /** Enable automatic subagent delegation when blocking (default: true) */
  autoDelegateEnabled?: boolean;
  /** Model to use for auto-delegated subagents (optional, uses default if omitted) */
  autoDelegateModel?: string;
}

export interface HealthCheckConfig {
  enabled: boolean;
  restartPatterns: string[];
  successPatterns: string[];
  successStatusCodes: number[];
}

export interface ParallelFirstConfig {
  enabled: boolean;
  message: string;
}

export interface SpawnModelPolicyConfig {
  enabled: boolean;
  defaultTier: 'cheap' | 'mid' | 'heavy';
  missingModelTier: 'cheap' | 'mid' | 'heavy';
  unknownModelTier: 'cheap' | 'mid' | 'heavy';
  tiers: {
    cheap: string[];
    mid: string[];
    heavy: string[];
  };
  cheapPatterns: string[];
  heavyPatterns: string[];
}

export interface WardenConfig {
  enabled: boolean;
  fileEditLimit: FileEditLimitConfig;
  taskToolLimit: TaskToolLimitConfig;
  healthCheck: HealthCheckConfig;
  parallelFirst: ParallelFirstConfig;
  spawnModelPolicy: SpawnModelPolicyConfig;
}

// ─── State Types ───

export interface SessionState {
  editedFiles: Set<string>;
  taskToolCalls: number;
  healthCheckRequired: boolean;
  healthCheckPassed: boolean;
  restartCommandInFlight: boolean;
  activeSubagents: number;
  lastAccessedAt: number;
}

export interface WardenState {
  sessions: Map<string, SessionState>;
}

// ─── Rule Types ───

export interface RuleContext {
  sessionId: string;
  sessionState: SessionState;
  isSubagent: boolean;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  toolResult?: unknown;
}

export type BlockResult = { block: true; blockReason: string } | undefined;

export type PromptInjection = { text: string } | undefined;

export interface Rule {
  name: string;
  onSessionStart?(ctx: RuleContext): void;
  onBeforeToolCall?(ctx: RuleContext): BlockResult | Promise<BlockResult>;
  onAfterToolCall?(ctx: RuleContext): void;
  onBeforePromptBuild?(ctx: RuleContext): PromptInjection;
  onSubagentSpawned?(ctx: RuleContext): void;
  onSubagentEnded?(ctx: RuleContext): void;
}

// ─── Plugin API (untyped from OpenClaw) ───

export interface PluginApi {
  on(event: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown): void;
  pluginConfig?: Partial<WardenConfig>;
  logger?: { info?: (msg: string) => void };
  /** Runtime services injected by OpenClaw — may include subagent spawning */
  runtime?: {
    subagent?: {
      run(opts: {
        task: string;
        runtime?: 'subagent';
        mode?: 'run' | 'session';
        model?: string;
      }): Promise<{ runId?: string; sessionKey?: string; status?: string; [key: string]: unknown }>;
      waitForRun(runId: string): Promise<unknown>;
      getSessionMessages(sessionKey: string): Promise<unknown[]>;
      getSession(sessionKey: string): Promise<unknown>;
      deleteSession(sessionKey: string): Promise<void>;
    };
  };
}
