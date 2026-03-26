# Conversation Record + Context Bridge — Design Spec

**Date:** 2026-03-26
**Scope:** Plugin that records session events to disk and enables cross-session context injection
**Plugin:** `@openacp/plugin-conversation-record`
**Depends on:** Phase 2b plugin infrastructure (completed on `redesign/microkernel-plugin-architecture`)

---

## Problem

OpenACP is a transient message relay — all ACP events flow through but are never persisted. When a session ends, its conversation history is gone. This means:

1. No way to review what happened in a past session
2. No way to share context between concurrent sessions (e.g., "use what session 3 built")
3. Adopted/resumed sessions lose naming context from prior conversation

## Solution

A single plugin with two capabilities:

1. **ConversationRecorder** — subscribe to EventBus events, append each event as a JSONL line per session
2. **ContextBridge** — `/context` command that reads recorded events from another session, formats them, and injects into the current session's next prompt via `agent:beforePrompt` middleware

## Architecture

```
Agent events → EventBus → ConversationRecorder → JSONL file (per session)

User: /context 3 → ContextBridge
  → read session 3 JSONL
  → filter conversation-relevant events
  → format summary
  → store import cursor (delta-aware)

User sends prompt → agent:beforePrompt middleware
  → prepend imported context
  → agent receives enriched prompt
```

---

## Section 1: ConversationRecorder

### Event subscription

Listen to these EventBus events:

| Event | What it captures |
|---|---|
| `session:created` | Session start metadata (agentName, userId, channelId, workingDir) |
| `session:ended` | Session end reason |
| `session:named` | Auto-generated session name |
| `agent:prompt` | User prompt text + attachments |
| `agent:event` | All agent events (text, tool_call, tool_update, thinking, etc.) |
| `permission:request` | Permission requests from agent |
| `permission:resolved` | User's permission decisions |

### Record levels

Config field `recordLevel` controls which `agent:event` subtypes are written:

| Level | Events recorded | Use case |
|---|---|---|
| `"minimal"` | `agent_message`, `user_message_chunk`, session lifecycle (`session:created`, `session:ended`, `session:named`) | Lightest, conversation text only |
| `"standard"` (default) | All of minimal + `tool_call`, `tool_call_update`, `error`, `permission:request`, `permission:resolved`, `agent:prompt` | Good balance for context bridge |
| `"full"` | All of standard + `agent_thought_chunk`, `current_mode_update`, `config_option_update`, `model_update`, `resource_content`, `resource_link`, `session_info_update` | Debug, audit, full replay |

Session lifecycle events (`session:created`, `session:ended`, `session:named`) are always recorded regardless of level.

### Storage format

Append-only JSONL, one file per session:

```
~/.openacp/plugins/data/conversation-record/
  sessions/
    <sessionId>.jsonl
```

Each line:

```json
{"ts":1711446000000,"type":"agent:prompt","sessionId":"abc123","data":{"text":"Build a REST API","attachments":[]}}
{"ts":1711446001000,"type":"agent:event","sessionId":"abc123","data":{"type":"agent_message","content":"I'll create..."}}
{"ts":1711446002000,"type":"agent:event","sessionId":"abc123","data":{"type":"tool_call","tool":{"name":"Write","id":"tc1"}}}
```

### Retention

On plugin boot, delete JSONL files older than `retentionDays` (default 30). Check file mtime, not event timestamps.

---

## Section 2: ContextBridge

### Command: `/context`

**No args** — list sessions available for import:

```
Active sessions:
  1. "Build Todo API" (claude) — 12 prompts
  2. "Fix auth bug" (claude) — 3 prompts
  3. "DB migration" (codex) — 7 prompts

Use /context <number> to import context.
```

Session list comes from `ctx.sessions` (requires `kernel:access`). Only show sessions that have a JSONL recording file.

**With number** — `/context 1`:

1. Read JSONL file for that session
2. Filter to conversation-relevant events only: `agent:prompt`, `agent_message`, `tool_call`, `tool_call_update`
3. Format into human-readable summary
4. Store in memory as pending context for the current session
5. Reply confirmation: `Context imported from "Build Todo API" (12 entries). Will be injected on your next prompt.`

### Context format (injected into prompt)

```
[Context imported from session "Build Todo API" (claude)]

Conversation:
- User: "Build a REST API for todo app with auth"
- Agent: Created Express + Prisma setup, JWT auth, 8 tests passing

Files created: src/routes/todo.ts, src/models/todo.ts, src/middleware/auth.ts
Files modified: package.json, tsconfig.json
Commands run: npm install, npx prisma generate, npm test (passed)

[End imported context]
```

Tool calls are summarized by type:
- `Write` / `Edit` → "Files created/modified: ..."
- `Bash` → "Commands run: ..."
- `Read` / `Grep` / `Glob` → omitted (low value for context)

Agent text is truncated to last 500 chars if longer.

### Delta-aware imports

Track per-session: `{ sourceSessionId, lastLineImported }`.

- First `/context 1`: import full history
- Subsequent `/context 1`: only new events since last import
- Different session `/context 2`: fresh import

Store import cursors in plugin storage: `ctx.storage.set('cursors', { ... })`.

### Size limits and smart truncation

- Max 100 events per import, max 8000 chars (~2000 tokens). Configurable via `maxContextEntries` and `maxContextChars`.
- When raw events fit within limits → inject full, no truncation.
- When raw events exceed limits → apply smart truncation algorithm (2 phases):

**Phase 1: Compress — remove redundancy**

5 compression rules applied in order:

| Rule | Input | Output |
|---|---|---|
| **Merge text chunks** | Multiple consecutive `agent_message` | Single merged message |
| **Collapse tool pairs** | `tool_call` + `tool_call_update`(completed) | Single entry: tool name + args + final status. Intermediate updates (running, pending) dropped. |
| **Compress explore runs** | Consecutive `Read`/`Grep`/`Glob`/`Ls` calls | Single entry: `"Explored: file1, file2, ... (N files)"`. File paths kept, content dropped. |
| **Truncate tool outputs** | Tool call output > 400 chars | First 200 chars + `[...truncated]` + last 200 chars |
| **Deduplicate retries** | Same tool call repeated (same name + similar args, e.g., `npm test` 5 times) | First + last attempt, middle collapsed to `"[...retried N times]"` |

**Phase 2: Budget — select by importance scoring**

If still over `maxContextChars` after compression:

Step 1 — **Reserved slots** (never cut):
- Session metadata (name, agent, workingDir)
- First user prompt (original intent)
- Last 10 events (current state)

Step 2 — **Score remaining events**:

| Event type | Score | Reason |
|---|---|---|
| User prompt | **10** | User intent = highest value |
| Agent text (final merged) | **8** | Agent conclusions/decisions |
| `Write` / `Edit` tool call | **7** | Actual code changes |
| `Bash` (commands) | **6** | Side-effect actions |
| Error | **6** | Need to know what failed |
| Permission resolved | **3** | Light context |
| Compressed explore run | **2** | Know what agent read, not critical |
| Single `Read` | **1** | Lowest value |

Step 3 — **Fill budget**: Calculate remaining chars after reserved slots. Iterate events chronologically, include highest-scored first. Ties broken by recency (later event wins).

Step 4 — **Build output**: Re-sort chronologically, insert `[...N events omitted]` at gaps.

### Middleware: `agent:beforePrompt`

```typescript
ctx.registerMiddleware('agent:beforePrompt', {
  priority: 100, // run early, before other middleware
  handler: async (payload, next) => {
    const pending = pendingContextMap.get(payload.sessionId)
    if (pending) {
      pendingContextMap.delete(payload.sessionId)
      return next({ ...payload, text: `${pending}\n\n${payload.text}` })
    }
    return next(payload)
  }
})
```

Context is injected once (on next prompt after `/context`), then cleared. User can `/context` again for fresh import.

---

## Section 3: Plugin Definition

```typescript
const plugin: OpenACPPlugin = {
  name: '@openacp/plugin-conversation-record',
  version: '1.0.0',
  description: 'Record session events and bridge context between sessions',
  permissions: [
    'events:read',          // subscribe to agent:event, session:*, etc.
    'commands:register',    // /context command
    'middleware:register',  // agent:beforePrompt injection
    'storage:read',         // read JSONL files, import cursors
    'storage:write',        // write JSONL files, import cursors
    'kernel:access',        // list active sessions via SessionManager
  ],
  async setup(ctx) { /* ... */ },
  async teardown() { /* flush pending writes, clear timers */ },
}
```

### Config

In `~/.openacp/config.json` under plugin config section:

```json
{
  "plugins": {
    "@openacp/plugin-conversation-record": {
      "recordLevel": "standard",
      "excludeEvents": [],
      "maxContextEntries": 100,
      "maxContextChars": 8000,
      "retentionDays": 30
    }
  }
}
```

All fields optional with defaults shown above.

- `recordLevel` — controls baseline set of events recorded (`"minimal"` | `"standard"` | `"full"`)
- `excludeEvents` — advanced: exclude specific event subtypes on top of the record level (e.g., `["agent_thought_chunk"]` to get `"full"` without thinking). Values are `AgentEvent.type` strings.

---

## Section 4: File Structure

```
src/plugins/conversation-record/
  index.ts                — OpenACPPlugin definition, setup/teardown
  recorder.ts             — ConversationRecorder class (event → JSONL)
  record-levels.ts        — recordLevel filter definitions
  context-bridge.ts       — ContextBridge class (/context command + middleware)
  context-formatter.ts    — Format JSONL events into human-readable summary
  types.ts                — RecordEntry, RecordLevel, ImportCursor types
  __tests__/
    recorder.test.ts
    context-bridge.test.ts
    context-formatter.test.ts
    record-levels.test.ts
```

---

## Section 5: Edge Cases

### Session has no recording file
`/context 3` → "No recording found for this session."

### Source session still active
Normal — JSONL is append-only, read what's there so far. New events after import are captured by next `/context 3`.

### Import into same session
`/context` in session 3, pick session 3 → "Cannot import context from the current session."

### Plugin loaded after sessions already active
Events before plugin loaded are not recorded. Recording starts from the moment of subscription. Existing sessions with no JSONL file are excluded from `/context` list.

### Concurrent writes
Single Node.js process = single event loop = no concurrent writes to same file. `fs.appendFile` is safe for JSONL append.

### Large JSONL files
At `"full"` level with long sessions, files can grow. Mitigated by:
- Retention cleanup on boot
- Context bridge reads line-by-line (streaming), not full file into memory
- Size limits on injection (maxContextEntries, maxContextChars)

---

## Backward Compatibility

New plugin, no existing data or config to migrate. Config fields all have defaults — plugin works with zero config.

---

## Expected Outcomes

| Metric | Value |
|---|---|
| New files | ~7 source + ~4 test |
| New lines (est.) | ~600-800 |
| Dependencies on core | EventBus events, SessionManager (list), PluginContext API |
| Breaking changes | None |
| Config changes | New optional plugin config section |
