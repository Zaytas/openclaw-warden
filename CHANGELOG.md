# Changelog

All notable changes to openclaw-warden will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-16

### Added

- **File Edit Limit** rule — limits how many distinct files the main agent can edit per turn, forcing delegation to subagents for substantial work. Default: 2 files.
- **Task Tool Limit** rule — limits total task-relevant tool calls (edit, write, exec, browser) before forcing delegation. Default: 2 calls.
- **Health Check Guidance** rule — injects a strong system prompt warning after a service restart is detected, urging the agent to verify health before claiming success. Scans only `exec` tool output for success patterns; ignores the restart command's own output. Operates via prompt guidance (not hard blocking).
- **Parallel-First Reminder** rule — injects a system prompt reminder to decompose tasks into parallel workstreams before dispatching subagents.
- All rules independently configurable via `openclaw.json` under `plugins.warden`.
- All rules apply only to the main agent session — subagents are unrestricted.
- Zero-config defaults — works out of the box with no configuration required.
- Logger injection for all rules — each rule receives a scoped logger via its factory function, with `console.log` as fallback.
- Session state management with TTL-based cleanup (1 hour), path normalization for file tracking, and pre-mutation check on tool counts (count after allowing, not before).
- Consistent `🛡️ WARDEN:` prefix across all block reasons and prompt injections.
- Example `AGENTS.md` template for recommended prompt patterns.
- Example `openclaw.json` with minimal and full configuration variants.
