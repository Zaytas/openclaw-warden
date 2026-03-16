# 🛡️ openclaw-warden

**Behavioral compliance guard for OpenClaw agents**

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-orange.svg)

---

## What It Does

Warden is an OpenClaw plugin that enforces behavioral rules on AI agents at runtime. Instead of relying on prompt instructions (which agents can drift from or ignore), Warden intercepts tool calls and prompt assembly through OpenClaw's plugin hook system — blocking non-compliant behavior where it can, and injecting strong guidance where it can't.

Four built-in rules keep your main agent honest:

- **File Edit Limit** — caps how many files the agent can edit per turn
- **Task Tool Limit** — caps total task-relevant tool calls before forcing delegation
- **Health Check Guidance** — injects a strong prompt warning after service restarts until a health check is confirmed
- **Parallel-First Reminder** — injects decomposition guidance before subagent dispatch

All rules apply **only to the main agent session**. Subagents are unrestricted.

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
[warden] Registered with 4 active rule(s): file-edit-limit, task-tool-limit, health-check, parallel-first
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

## FAQ

### Will this block my subagents?

No. All rules check the session type and only apply to the main agent session. Subagents operate without any Warden restrictions — they're the workhorses that the main agent delegates to.

### What happens when a tool is blocked?

The agent receives the block reason as a tool error response (not a crash or exception). The error message explains what limit was hit and what the agent should do instead (typically: delegate to a subagent). Well-behaved models adapt immediately.

### Can I add custom rules?

Yes. Create a new file in `src/rules/` that implements the `Rule` interface:

```typescript
export interface Rule {
  name: string;
  onSessionStart?(ctx: RuleContext): void;
  onBeforeToolCall?(ctx: RuleContext): BlockResult;
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

No. Warden ships with sensible defaults that work well for most setups. Install it, restart the gateway, and you're protected. Tune the limits later if needed.

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
