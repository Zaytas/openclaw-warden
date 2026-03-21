# 🛡️ openclaw-warden

**Behavioral compliance guard for OpenClaw agents**

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-orange.svg)

---

## What It Does

Warden is an OpenClaw plugin that enforces behavioral rules on AI agents at runtime. Instead of relying on prompt instructions (which agents can drift from or ignore), Warden intercepts tool calls and prompt assembly through OpenClaw's plugin hook system — blocking non-compliant behavior where it can, and injecting strong guidance where it can't.

Five built-in rules keep your main agent honest:

- **File Edit Limit** — caps how many files the agent can edit per turn
- **Task Tool Limit** — caps total task-relevant tool calls before forcing delegation
- **Health Check Guidance** — injects a strong prompt warning after service restarts until a health check is confirmed
- **Parallel-First Reminder** — injects decomposition guidance before subagent dispatch
- **Spawn Model Policy** — enforces cost-appropriate model selection when spawning subagents

Most rules apply only to the main agent session. The spawn model policy enforces at all depths (subagents and their children).

## Why

Prompt instructions are suggestions. Agents follow them *most* of the time, but drift is inevitable — especially on complex tasks. An agent told to "delegate substantial work" will sometimes barrel through 15 file edits itself. An agent told to "verify the service is healthy" will sometimes skip the check and tell you everything's fine.

Warden makes these rules deterministic where possible: file edit and task tool limits are hard blocks — the tool call is rejected and the agent must adapt. For cases where hard blocking isn't feasible (like health checks, which need to influence responses rather than tool calls), Warden injects strong prompt-level guidance that steers the agent in the right direction.

**Prompts suggest. Warden enforces — or strongly insists.**

## Requirements

- **OpenClaw** with plugin support (plugin hook API)
- **Node.js** >= 18 (for building the plugin)
- **npm** (included with Node.js)

### Hook Compatibility

Warden requires OpenClaw's plugin hook API with the following hooks: `before_tool_call`, `after_tool_call`, `before_prompt_build`, `before_agent_start`, `subagent_spawned`, `subagent_ended`. Check your OpenClaw version supports these hooks.

## Quick Start

```bash
# Clone into your preferred plugins directory
mkdir -p ~/.openclaw/plugins
cd ~/.openclaw/plugins
git clone https://github.com/Zaytas/openclaw-warden.git warden
cd warden
npm install --include=dev
npm run build
```

Then add the plugin to your `openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/plugins"]
    },
    "entries": {
      "warden": {
        "enabled": true
      }
    }
  }
}
```

Restart the gateway to load the plugin:

```bash
openclaw gateway restart
```

> **Note:** The root `index.ts` is a shim that re-exports the built plugin for OpenClaw's plugin discovery. The repository contains TypeScript source. You must run `npm install --include=dev` and `npm run build` to generate the `dist/` output that OpenClaw loads. The `--include=dev` flag is required because TypeScript and the build toolchain are dev dependencies — a plain `npm install` in production environments (where `NODE_ENV=production`) would skip them, causing the build to fail. Node.js >= 18 and npm are required.

Warden works with zero configuration using sensible defaults.

### Verifying Installation

After restarting the gateway, verify the plugin loaded:

```bash
openclaw plugins list
```

You should see `warden` in the output. You can also run `openclaw plugins doctor` to check for any issues.

In the gateway logs, look for:

```
[warden] Registered with 5 active rule(s): file-edit-limit, task-tool-limit, health-check, parallel-first, spawn-model-policy
```

If you see this, Warden is active. If a rule is disabled via config, the count and list will reflect that.

## Configuration

All configuration lives in your `openclaw.json` under `plugins.entries.warden.config`. Every option is optional — defaults are designed to work well out of the box.

There are two levels of `enabled`:

- **Plugin-level** (`plugins.entries.warden.enabled`): Master switch. Set to `false` to prevent the plugin from loading at all.
- **Per-rule** (e.g., `plugins.entries.warden.config.fileEditLimit.enabled`): Disable individual rules while keeping the plugin active.

### Top-Level (inside `config`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for all rules. Set to `false` to disable all Warden rules while keeping the plugin loaded. |

### `fileEditLimit`

Limits how many distinct files the main agent can edit in a single turn.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable this rule. |
| `maxFiles` | number | `2` | Maximum distinct files the main agent can edit per turn. |
| `tools` | string[] | `["edit", "write"]` | Tool names that count as file edits. |

### `taskToolLimit`

Limits total task-relevant tool calls before the agent must delegate.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable this rule. |
| `maxCalls` | number | `2` | Maximum task-relevant tool calls per turn. |
| `tools` | string[] | `["edit", "write", "exec", "browser"]` | Tool names that count toward the limit. |
| `autoDelegateEnabled` | boolean | `true` | When a tool call is blocked by the limit, automatically spawn a subagent to continue the work. If disabled, the agent receives a block message and must delegate manually. |
| `autoDelegateModel` | string | *(parent model)* | Model to use for auto-delegated subagents. If omitted, inherits the default model. |

### `healthCheck`

Injects a strong system prompt warning after a service restart is detected, urging the agent to run a health check before claiming success. This is prompt-level guidance — it steers the agent but cannot hard-block responses.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable this rule. |
| `restartPatterns` | string[] | `["docker restart", "docker compose restart", "docker-compose restart", "systemctl restart", "pm2 restart", "service restart"]` | Command patterns that trigger the health check requirement. |
| `successPatterns` | string[] | `["healthy", "\"status\":\"ok\"", "\"status\": \"ok\"", "health check passed", "is healthy", "is ready", "service is running", "started successfully"]` | Output patterns that satisfy the health check. |
| `successStatusCodes` | number[] | `[200]` | HTTP status codes that satisfy the health check when found in exec output (e.g., `HTTP/1.1 200`, `"status": 200`). |

### `parallelFirst`

Injects a system prompt reminder to decompose work into parallel subagent workstreams.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable this rule. |
| `message` | string | *(see below)* | Custom reminder message injected into the system prompt. |

Default `message`:
> "🛡️ WARDEN: Before dispatching subagents, decompose the task into independent parallel workstreams. Identify which pieces of work have no dependencies on each other, then spawn ALL independent subagents simultaneously. Do not serialize work that can be parallelized. Plan first, then dispatch."

### `spawnModelPolicy`

Enforces cost-appropriate model selection when spawning subagents. **Disabled by default** — you must configure model tiers for your setup before enabling.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable/disable this rule. Must be explicitly enabled after configuring tiers. |
| `defaultTier` | `"cheap"` \| `"mid"` \| `"heavy"` | `"mid"` | Tier assigned to tasks that don't match any pattern. |
| `missingModelTier` | `"cheap"` \| `"mid"` \| `"heavy"` | `"heavy"` | Tier assumed when no model is specified (inherits parent model). |
| `unknownModelTier` | `"cheap"` \| `"mid"` \| `"heavy"` | `"heavy"` | Tier assumed when the model doesn't match any configured tier pattern. |
| `tiers` | object | *(see below)* | Model name substring patterns for each tier. |
| `cheapPatterns` | string[] | *(see below)* | Regex patterns — tasks matching these are classified as cheap. |
| `heavyPatterns` | string[] | *(see below)* | Regex patterns — tasks matching these are classified as heavy. Heavy wins when both match. |

Default `tiers` (examples — **configure these for your models**):
```json
{
  "cheap": ["haiku", "gpt-4o-mini"],
  "mid": ["sonnet", "gpt-4o"],
  "heavy": ["opus", "gpt-5"]
}
```

> ⚠️ **These tier patterns are examples based on Anthropic and OpenAI model families.** If you use other providers (Gemini, Ollama, Mistral, DeepSeek, local models, etc.), you **must** configure `tiers` with patterns that match your model names before enabling this rule. Any model that doesn't match a configured pattern is treated as the `unknownModelTier` (default: heavy).

Partial `tiers` overrides are deep-merged — you can override just one tier without losing the others:
```json
{
  "spawnModelPolicy": {
    "enabled": true,
    "tiers": {
      "cheap": ["flash", "haiku", "gpt-4o-mini", "my-local-llama"]
    }
  }
}
```

**Escape hatch:** Add `[model-tier:heavy]` (or `mid`/`cheap`) to the task text to override pattern-based classification. Useful when a task is misclassified by the heuristic.

## Rules Deep Dive

### 1. File Edit Limit

**When it fires:** The main agent attempts to edit or write to a file after already touching `maxFiles` distinct files in the current turn.

**What it blocks:** The `edit` or `write` tool call. The agent receives an error like:
```
🛡️ WARDEN: File edit limit reached — you've edited 2 distinct file(s) this turn.
Delegate further file edits to a subagent, or reply to the user with your progress so far.
```

**Why it exists:** Without this, agents tend to make sweeping changes across many files themselves, even when instructed to delegate. This forces a natural breakpoint where the agent must spin up a subagent for additional work — producing better-structured, more reviewable changes.

> **Known limitation:** OpenClaw's `after_tool_call` hook fires regardless of whether the tool call succeeded or failed. This means failed edits (e.g., a write to a read-only path, or an edit where the old text wasn't found) still count toward the file limit. The hook API does not currently expose success/failure status, so Warden cannot distinguish between the two.

### 2. Task Tool Limit

**When it fires:** The main agent makes its (maxCalls + 1)th task-relevant tool call in a single turn.

**What it blocks:** Any tool in the configured `tools` list. The agent receives:
```
🛡️ WARDEN: Task tool call limit reached — 2 calls to edit/write/exec/browser per turn.
Delegate remaining work to a subagent, or reply to the user with your progress so far.
```

**Why it exists:** A broader version of the file edit limit. Catches cases where the agent is running too many shell commands, browser actions, or file operations directly instead of coordinating subagents. Keeps the main agent in a coordinator role.

#### Auto-Delegation

When the task tool limit blocks a call and `autoDelegateEnabled` is `true` (the default), Warden
attempts to automatically spawn a subagent to continue the work — removing model
discretion from the delegation decision entirely.

**How it works:**
1. Warden builds a task description from the blocked tool call (tool name, parameters, context)
2. If `api.runtime.subagent` is available, it spawns a subagent directly via `runtime.subagent.run()`
3. The agent is told a subagent was spawned and can wait for its result or continue
4. If the runtime API is unavailable, Warden falls back to an enhanced block message with structured
   delegation instructions that strongly direct the model to spawn a subagent itself

**Configuration examples:**

Disable auto-delegation (fall back to manual block messages):
```json
{
  "plugins": {
    "entries": {
      "warden": {
        "config": {
          "taskToolLimit": {
            "autoDelegateEnabled": false
          }
        }
      }
    }
  }
}
```

Use a specific model for auto-delegated subagents:
```json
{
  "plugins": {
    "entries": {
      "warden": {
        "config": {
          "taskToolLimit": {
            "autoDelegateModel": "anthropic/claude-sonnet-4"
          }
        }
      }
    }
  }
}
```

### 3. Health Check Guidance

**When it fires:** After the agent runs an `exec` command matching a restart pattern (e.g., `docker restart myservice`), Warden enters a "pending health check" state. It then monitors subsequent `exec` results for success patterns or status codes. The restart command's own output is ignored — only follow-up commands count.

**What it does:** Injects a strong system prompt warning into the agent's context, instructing it to run a health check before reporting success. Unlike the file edit and task tool limits, this rule cannot hard-block responses — it operates through prompt-level guidance. In practice, models follow the injected instruction reliably, but it's not deterministic enforcement.

The injected prompt reads:
```
🛡️ WARDEN: Health check required — a service restart was detected but no successful
health check has been confirmed yet. Do NOT tell the user the service is ready or
suggest they refresh/retry. First, run a health check and confirm the service is
actually healthy before reporting success.
```

Once a follow-up `exec` result matches a configured success pattern (e.g., `"healthy"`, `HTTP/1.1 200`), the health check state clears and the guidance is removed.

**Why it exists:** Agents love to restart a service and immediately say "Done! The service should be back up." This rule injects a hard-to-ignore reminder to actually verify — and in testing, it works. But be aware it's guidance, not a hard gate.

### 4. Parallel-First Reminder

**When it fires:** During prompt assembly, before the agent processes a new user message.

**What it does:** Injects a system-level reminder into the prompt, nudging the agent to think about parallelization before dispatching subagents. Unlike the other rules, this one doesn't block — it guides.

**Why it exists:** Agents default to sequential thinking. Given three independent tasks, they'll often dispatch one subagent, wait for it, then dispatch the next. The reminder encourages simultaneous dispatch of independent workstreams.

### 5. Spawn Model Policy

**When it fires:** The agent (at any depth — main agent, subagent, or grandchild) attempts to spawn a subagent via `sessions_spawn`.

**What it blocks:** The spawn call, if the requested model's cost tier exceeds the task's complexity tier. The agent receives:
```
🛡️ WARDEN: Model tier policy — this task was classified as "cheap" complexity
but the requested model is "heavy" tier. Use a model matching a configured
cheap-tier pattern (haiku, gpt-4o-mini). If this task truly requires a stronger
model, add [model-tier:heavy] to the task text. Classification reason: matched
cheap pattern.
```

**How it classifies tasks:** Task text is matched against configurable regex patterns:
- If it matches a `heavyPatterns` regex → heavy (heavy wins when both match)
- If it matches a `cheapPatterns` regex → cheap
- Otherwise → `defaultTier` (default: mid)

**How it classifies models:** The model string is substring-matched against tier patterns. When multiple tiers match, the longest (most specific) pattern wins — so `gpt-4o-mini` correctly matches cheap, not mid, even though it contains `gpt-4o`.

**Why it exists:** Expensive models (Opus, GPT-5) are overkill for trivial tasks like listing files or running a grep. Without enforcement, agents consistently spawn subagents using the parent's expensive model for everything. Prompt-level guidance doesn't stick. This rule makes cost discipline deterministic.

**Key differences from other rules:**
- **Enforces at all depths** — unlike other rules which skip subagents, this applies to every `sessions_spawn` call regardless of session type
- **Disabled by default** — requires explicit configuration of model tiers before enabling
- **Has an escape hatch** — `[model-tier:X]` annotation in task text overrides pattern classification

## Recommended Prompt Patterns

Warden enforces limits, but it works best when paired with `AGENTS.md` instructions that align with its philosophy. The agent should *want* to delegate; Warden is the backstop for when it forgets.

### Example AGENTS.md excerpt:

```markdown
## Operating Stance
You are primarily a coordinator.
- Simple tasks (one-step lookups, quick answers): handle directly
- Meaningful work (multi-file changes, research, complex operations): delegate to subagents
- Independent workstreams: parallelize — spawn ALL agents simultaneously
- Always verify deliverables before reporting success

## Delegation Rules
- If a task touches more than 2 files, delegate it
- If a task requires more than 3 tool calls, delegate it
- When spawning multiple subagents, identify dependencies and parallelize everything independent
```

See `examples/AGENTS.md` for a complete template.

## How It Works

Warden uses OpenClaw's plugin hook system, which provides several interception points:

1. **`before_tool_call`** — Fired before every tool invocation. Warden inspects the tool name, arguments, and session context (main agent vs. subagent, current turn counters) to decide whether to allow or block the call. Blocked calls return an error message to the agent.

2. **`before_prompt_build`** — Fired when the system prompt is being constructed. Warden can inject additional instructions (used by the Health Check and Parallel-First rules).

3. **`after_tool_call`** — Fired after a tool completes. Used by the Health Check rule to scan tool output for success patterns.

4. **`subagent_spawned` / `subagent_ended`** — Fired when subagents are created or complete. Used by the Parallel-First rule to track active subagent count.

Each rule is implemented as an independent module in `src/rules/` that exports a standard `Rule` interface. Rules are loaded at startup and evaluated in order. The first rule that blocks a call wins.

Session state (edit counts, tool call counts, pending health checks) is tracked per-turn and resets automatically.

### Troubleshooting: World-Writable Paths (WSL2 / Docker)

If the plugin fails to load with permission-related errors, your plugin directory may be on a
filesystem mounted with overly permissive modes (common with Docker bind-mounts and WSL2
cross-filesystem paths like `/mnt/c/...`).

**Symptoms:**
- Plugin silently fails to load
- OpenClaw reports permission/security errors during plugin discovery

**Fix:** Ensure the plugin directory and its contents are not world-writable:
```bash
chmod -R o-w ~/.openclaw/plugins/warden
```

On Docker with bind-mounts from Windows/NTFS, files always appear as mode 777. Set
`OPENCLAW_SKIP_WORLD_WRITABLE_CHECK=1` in your environment or docker-compose.yml to bypass
the security check.

## FAQ

### Will this block my subagents?

Most rules only apply to the main agent session — subagents operate without restrictions. The one exception is **Spawn Model Policy**, which enforces at all depths to prevent cost-tier escalation in nested spawns.

### What happens when a tool is blocked?

The agent receives the block reason as a tool error response (not a crash or exception). The error message explains what limit was hit and what the agent should do instead (typically: delegate to a subagent). Well-behaved models adapt immediately.

### Can I add custom rules?

Yes. Create a new file in `src/rules/` that implements the `Rule` interface:

```typescript
export interface Rule {
  name: string;
  onSessionStart?(ctx: RuleContext): void;
  onBeforeToolCall?(ctx: RuleContext): BlockResult | Promise<BlockResult>;
  onAfterToolCall?(ctx: RuleContext): void;
  onBeforePromptBuild?(ctx: RuleContext): PromptInjection;
  onSubagentSpawned?(ctx: RuleContext): void;
  onSubagentEnded?(ctx: RuleContext): void;
}
```

Export your rule factory as a function that accepts its config and a `log` function:

```typescript
export function createMyRule(
  config: MyRuleConfig,
  log: (msg: string) => void,
): Rule {
  // ...
}
```

Add it to the rules array in `src/index.ts` (passing `makeRuleLogger(api, 'my-rule')` as the logger), and restart the gateway.

### Do I need to configure anything?

Most rules work with sensible defaults out of the box. The one exception is **Spawn Model Policy**, which ships disabled — you need to configure `tiers` with patterns matching your model names, then set `enabled: true`. All other rules are active immediately after install.

### Can I disable just one rule?

Yes. Each rule has its own `enabled` flag inside `plugins.entries.warden.config`. For example, to disable only the health check rule:

```json
{
  "plugins": {
    "entries": {
      "warden": {
        "config": {
          "healthCheck": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

## License

[MIT](LICENSE) © 2026 Matt DeGraw

## Contributing

Contributions are welcome! Whether it's a new rule, a bug fix, or documentation improvements:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new rules
5. Submit a pull request

For new rules, please include:
- The rule implementation in `src/rules/`
- Configuration schema with sensible defaults
- Documentation in the README
- At least basic test coverage
