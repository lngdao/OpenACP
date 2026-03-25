# Plugin API v2 — Unified Plugin System for OpenACP

## Overview

OpenACP's current plugin system only supports one type: channel adapters (AdapterFactory). This limits community contributions to "add a new messaging platform" — no way to add features, modify behavior, or extend functionality.

Plugin API v2 introduces a **unified plugin interface** where a single plugin can hook into events, register commands, add middleware, provide storage, access core services, and optionally act as a channel adapter. Modular, flexible, plug-and-play, developer-friendly.

## Motivation

Features like Context Bridge, Conversation Logger, Agent Room, auto-approve rules, message translation, etc. cannot be built as plugins today. They require changes to core code, which:

- Increases core complexity
- Requires maintainer review for every community feature
- Makes OpenACP monolithic over time

With Plugin API v2, these become community plugins:

```bash
openacp plugin add @openacp/plugin-context-bridge
openacp plugin add @openacp/plugin-conversation-log
openacp plugin add @community/plugin-auto-approve
openacp plugin add @community/plugin-translate
```

Install, enable, done. No core changes needed.

## Plugin Interface

```typescript
interface OpenACPPlugin {
  /** Unique plugin identifier */
  name: string

  /** Semver version */
  version: string

  /** Human-readable description */
  description?: string

  /**
   * Called during startup. Register hooks, commands, middleware here.
   * Plugins receive a PluginContext with access to events, services, and storage.
   */
  setup(ctx: PluginContext): Promise<void>

  /**
   * Called during shutdown. Cleanup resources, flush storage, etc.
   * Called in reverse order of setup.
   */
  teardown?(): Promise<void>

  /**
   * Optional: plugin can also act as a channel adapter.
   * This provides backward compatibility path for v1 adapter plugins.
   */
  createAdapter?(core: OpenACPCore, config: ChannelConfig): ChannelAdapter
}
```

A plugin can use as many or as few capabilities as needed. A simple event listener uses only `ctx.on()`. A full-featured plugin might use events, commands, middleware, and storage.

## PluginContext API

PluginContext is the single entry point for all plugin capabilities. Organized in tiers by stability:

### Tier 1 — Events (read-only, stable)

```typescript
interface PluginContext {
  /**
   * Subscribe to system events. All listeners are automatically
   * cleaned up on plugin teardown.
   */
  on(event: PluginEvent, handler: Function): void
  off(event: PluginEvent, handler: Function): void
}
```

**Available events:**

| Event | Payload | Description |
|-------|---------|-------------|
| `session:created` | `{ sessionId, agentName, workingDir, channelId }` | New session started |
| `session:ended` | `{ sessionId, reason }` | Session finished/cancelled/errored |
| `session:named` | `{ sessionId, name }` | Session auto-named |
| `agent:event` | `{ sessionId, event: AgentEvent }` | Any agent event (text, tool_call, thought, plan, usage, etc.) |
| `agent:prompt` | `{ sessionId, text, attachments? }` | User sent prompt to agent |
| `adapter:outgoing` | `{ sessionId, message: OutgoingMessage }` | Message about to be sent to user |
| `permission:request` | `{ sessionId, request: PermissionRequest }` | Agent requests permission |
| `permission:resolved` | `{ sessionId, requestId, decision }` | User responded to permission |

### Tier 2 — Actions (side effects, stable)

```typescript
interface PluginContext {
  /**
   * Register a command that users can invoke from any adapter.
   * Commands are automatically registered with all active adapters.
   */
  registerCommand(def: CommandDef): void

  /**
   * Register middleware to intercept and modify data at specific points.
   * Middleware runs in registration order. Return modified data or null to skip.
   */
  registerMiddleware(hook: MiddlewareHook, handler: MiddlewareFn): void

  /**
   * Send a message to a session's topic/thread.
   * Used by plugins to communicate with users (e.g., status updates, notifications).
   */
  sendMessage(sessionId: string, content: OutgoingMessage): Promise<void>

  /**
   * Plugin-scoped persistent storage.
   * Stored in ~/.openacp/plugins/<plugin-name>/data/
   */
  storage: PluginStorage

  /**
   * Plugin-scoped logger (prefixed with plugin name).
   */
  log: Logger
}
```

**Command definition:**

```typescript
interface CommandDef {
  /** Command name without slash, e.g., "context" for /context */
  name: string

  /** Short description shown in command list */
  description: string

  /** Command usage pattern, e.g., "<session-number>" */
  usage?: string

  /**
   * Command handler. Receives parsed args and session context.
   * Return void — use ctx.sendMessage() to respond.
   */
  handler(args: CommandArgs): Promise<void>
}

interface CommandArgs {
  /** Raw argument string after command name */
  raw: string

  /** Session ID where command was invoked (null if from notification topic) */
  sessionId: string | null

  /** Channel ID (telegram, discord, slack) */
  channelId: string

  /** User ID who invoked the command */
  userId: string

  /** Reply helper — shortcut for ctx.sendMessage() to the invoking topic */
  reply(content: string | OutgoingMessage): Promise<void>
}
```

**Middleware hooks:**

| Hook | Signature | Description |
|------|-----------|-------------|
| `before:prompt` | `(sessionId, text, attachments?) => { text, attachments? }` | Modify prompt before sending to agent |
| `after:response` | `(sessionId, message: OutgoingMessage) => OutgoingMessage` | Modify outgoing message before adapter sends |
| `before:session` | `(params: SessionCreateParams) => SessionCreateParams` | Modify session creation params |

Middleware can return `null` to suppress (e.g., filter out certain messages).

**Plugin storage:**

```typescript
interface PluginStorage {
  /** Get a value by key. Returns undefined if not found. */
  get<T>(key: string): Promise<T | undefined>

  /** Set a value. Persisted to disk (debounced). */
  set<T>(key: string, value: T): Promise<void>

  /** Delete a key. */
  delete(key: string): Promise<void>

  /** List all keys. */
  keys(): Promise<string[]>

  /** Get all entries. */
  entries<T>(): Promise<[string, T][]>
}
```

Storage location: `~/.openacp/plugins/<plugin-name>/data/storage.json`

### Tier 3 — Core access (advanced, may change between versions)

```typescript
interface PluginContext {
  /**
   * Direct access to core services.
   * WARNING: These APIs may change between OpenACP versions.
   * Use Tier 1-2 APIs when possible.
   */
  core: OpenACPCore
  sessions: SessionManager
  config: ConfigManager  // read-only access
  eventBus: EventBus
}
```

## Plugin Examples

### Example 1: Conversation Logger (simple event listener)

```typescript
import type { OpenACPPlugin } from '@openacp/cli'

export default {
  name: 'conversation-log',
  version: '1.0.0',
  description: 'Records all conversation events per session',

  async setup(ctx) {
    ctx.on('agent:prompt', async ({ sessionId, text }) => {
      const log = await ctx.storage.get(`session:${sessionId}`) || []
      log.push({ role: 'user', text, timestamp: Date.now() })
      await ctx.storage.set(`session:${sessionId}`, log)
    })

    ctx.on('agent:event', async ({ sessionId, event }) => {
      if (event.type === 'text') {
        const log = await ctx.storage.get(`session:${sessionId}`) || []
        log.push({ role: 'agent', text: event.content, timestamp: Date.now() })
        await ctx.storage.set(`session:${sessionId}`, log)
      }
    })

    ctx.registerCommand({
      name: 'history',
      description: 'Show conversation history for this session',
      async handler({ sessionId, reply }) {
        const log = await ctx.storage.get(`session:${sessionId}`) || []
        const summary = log.map(e =>
          `${e.role === 'user' ? '👤' : '🤖'} ${e.text.slice(0, 100)}`
        ).join('\n')
        await reply(summary || 'No history recorded.')
      }
    })
  }
} satisfies OpenACPPlugin
```

### Example 2: Context Bridge (cross-session context import)

```typescript
import type { OpenACPPlugin } from '@openacp/cli'

export default {
  name: 'context-bridge',
  version: '1.0.0',
  description: 'Import conversation context from one session into another',

  async setup(ctx) {
    // Track activity per session
    ctx.on('agent:event', async ({ sessionId, event }) => {
      if (event.type === 'tool_call' || event.type === 'tool_update') {
        const activity = await ctx.storage.get(`activity:${sessionId}`) || []
        activity.push({
          agent: 'unknown', // resolved from session
          action: event.kind || 'other',
          target: event.name,
          status: event.status,
          timestamp: Date.now()
        })
        await ctx.storage.set(`activity:${sessionId}`, activity)
      }
    })

    ctx.registerCommand({
      name: 'context',
      description: 'Import context from another active session',
      async handler({ sessionId, raw, reply }) {
        if (!raw.trim()) {
          // List active sessions
          const sessions = ctx.sessions.getActiveSessions()
          const list = sessions
            .filter(s => s.id !== sessionId)
            .map((s, i) => `${i + 1}. ${s.agentName} — "${s.name || 'Unnamed'}"`)
            .join('\n')
          await reply(list || 'No other active sessions.')
          return
        }

        // Import from selected session
        const target = raw.trim()
        const activity = await ctx.storage.get(`activity:${target}`) || []
        const context = buildEnrichedContext(activity)

        // Inject into next prompt via middleware
        ctx.registerMiddleware('before:prompt', (sid, text) => {
          if (sid === sessionId) {
            return { text: `${context}\n\nUser request: ${text}` }
          }
          return { text }
        })

        await reply(`Imported context from session. It will be included in your next message.`)
      }
    })
  }
} satisfies OpenACPPlugin
```

### Example 3: Auto-Approve Plugin (middleware)

```typescript
import type { OpenACPPlugin } from '@openacp/cli'

export default {
  name: 'auto-approve',
  version: '1.0.0',
  description: 'Auto-approve read operations, require approval for writes',

  async setup(ctx) {
    ctx.on('permission:request', async ({ sessionId, request }) => {
      // Auto-approve read operations
      if (request.kind === 'read' || request.kind === 'search') {
        // resolve permission automatically
        ctx.core.resolvePermission(sessionId, request.id, 'allow-once')
      }
    })

    ctx.registerCommand({
      name: 'autoapprove',
      description: 'Configure auto-approve rules',
      usage: '<on|off|status>',
      async handler({ raw, reply }) {
        await reply(`Auto-approve is ${raw === 'off' ? 'disabled' : 'enabled'}`)
      }
    })
  }
} satisfies OpenACPPlugin
```

### Example 4: Adapter Plugin (backward compat + v2)

```typescript
import type { OpenACPPlugin, ChannelAdapter } from '@openacp/cli'

export default {
  name: 'whatsapp-adapter',
  version: '1.0.0',
  description: 'WhatsApp adapter for OpenACP',

  async setup(ctx) {
    ctx.log.info('WhatsApp plugin loaded')
  },

  createAdapter(core, config) {
    return new WhatsAppAdapter(core, config)
  }
} satisfies OpenACPPlugin
```

## Installation & Configuration

### CLI Commands

```bash
openacp plugin add <package>       # Install plugin from npm
openacp plugin remove <package>    # Uninstall plugin
openacp plugin list                # Show all plugins with status
```

### What `openacp plugin add` does:

1. `npm install <package>` in `~/.openacp/plugins/`
2. Load module, validate it exports `OpenACPPlugin`
3. Add entry to `~/.openacp/config.json`:

```json
{
  "plugins": [
    {
      "package": "@openacp/plugin-context-bridge",
      "enabled": true
    },
    {
      "package": "@community/plugin-auto-approve",
      "enabled": true,
      "config": {
        "approveReads": true,
        "approveSearches": true
      }
    }
  ]
}
```

### Plugin-specific config

Plugins can declare a config schema. User configures via the `config` field in the plugins array. Plugin accesses it via `ctx.pluginConfig`.

```typescript
interface PluginContext {
  /** Plugin-specific config from config.json, validated at load time */
  pluginConfig: Record<string, unknown>
}
```

## Startup Lifecycle

```
OpenACP startup
    │
    ▼
1. Load config
2. Init logger
3. Init core services (SessionManager, EventBus, AgentManager, etc.)
4. ── Plugin phase ──────────────────────────────────
   │  a. Read plugins[] from config
   │  b. For each plugin (in config order):
   │     - Import module from ~/.openacp/plugins/
   │     - Detect type:
   │       - exports OpenACPPlugin → v2 plugin
   │       - exports AdapterFactory → v1 legacy (wrap + deprecation warning)
   │     - Call plugin.setup(ctx)
   │     - Register commands, middleware, event listeners
   │  c. Error in setup → log error, skip plugin, continue
   ─────────────────────────────────────────────────
5. Collect all registered commands from plugins
6. Init built-in adapters (Telegram, Discord, Slack)
   → Pass registered commands to adapters for platform registration
7. Init v2 adapter plugins (createAdapter())
8. Start all adapters
9. Ready — emit 'system:ready' event
    │
    ▼
Shutdown (reverse order)
1. Emit 'system:shutdown' event
2. Stop all adapters
3. Call plugin.teardown() (reverse order of setup)
4. Cleanup core services
```

**Key points:**
- Plugins setup BEFORE adapters start (so commands are registered first)
- Plugin ordering follows config array (if A depends on B, list B first)
- No complex dependency resolution — keep it simple
- One plugin failure does not affect others

## Backward Compatibility

### v1 plugins (AdapterFactory) continue to work:

```typescript
// v1 plugin — still works
export const adapterFactory = {
  name: 'my-adapter',
  createAdapter(core, config) {
    return new MyAdapter(core, config)
  }
}
```

When detected:
1. Wrapped into a minimal OpenACPPlugin shell automatically
2. Deprecation warning logged: "Plugin 'my-adapter' uses legacy AdapterFactory format. Please migrate to OpenACPPlugin interface."
3. `createAdapter()` called normally

### v1 CLI commands still work:

| v1 Command | Behavior | Note |
|------------|----------|------|
| `openacp install <pkg>` | Works, installs to plugins dir | Logs deprecation: "Use 'openacp plugin add' instead" |
| `openacp uninstall <pkg>` | Works | Logs deprecation |
| `openacp plugins` | Works, lists all plugins | Logs deprecation |

### Config backward compat:

Old config (channels with `adapter` field):
```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "adapter": "@openacp/adapter-whatsapp"
    }
  }
}
```

Still works. System checks `channels.*.adapter` for v1 plugins, `plugins[]` for v2 plugins.

## Command Registration & Adapter Integration

When a plugin registers a command, it needs to appear in all active adapters:

### Telegram
- Commands registered via `bot.api.setMyCommands()` (added to bot menu)
- Handler registered in bot middleware
- Commands scoped per-topic (session commands only in session topics)

### Discord
- Registered as slash commands via Discord API
- Handler in interaction listener

### Slack
- Registered as slash commands via Slack API
- Handler in event listener

### Implementation:

```typescript
// Plugin registers
ctx.registerCommand({
  name: 'context',
  description: 'Import context from another session',
  handler: async (args) => { ... }
})

// PluginManager collects all registered commands
// Passes them to each adapter during adapter.start()
// Each adapter maps CommandDef to platform-specific commands
```

Adapters implement a new optional method:

```typescript
abstract class ChannelAdapter {
  // ... existing methods ...

  /** Register plugin commands. Called after all plugins are loaded. */
  async registerPluginCommands(commands: CommandDef[]): Promise<void> {}
}
```

## Error Isolation

Plugins run in the same process (no sandboxing) but with error boundaries:

```typescript
// Plugin setup — wrapped in try/catch
try {
  await plugin.setup(ctx)
} catch (err) {
  log.error({ plugin: plugin.name, err }, 'Plugin setup failed, skipping')
  disabledPlugins.add(plugin.name)
}

// Event handlers — wrapped individually
ctx.on('agent:event', async (payload) => {
  try {
    await handler(payload)
  } catch (err) {
    log.error({ plugin: plugin.name, err }, 'Plugin event handler error')
    // Continue — don't crash other plugins or core
  }
})

// Commands — wrapped
async function executeCommand(cmd, args) {
  try {
    await cmd.handler(args)
  } catch (err) {
    await args.reply(`Plugin error: ${err.message}`)
  }
}
```

## Plugin Storage

Each plugin gets isolated persistent storage:

```
~/.openacp/plugins/
  ├── package.json              # npm dependencies
  ├── node_modules/             # installed packages
  └── data/
      ├── context-bridge/
      │   └── storage.json      # plugin-scoped data
      ├── conversation-log/
      │   └── storage.json
      └── auto-approve/
          └── storage.json
```

Storage implementation: JSON file with debounced writes (same pattern as SessionStore). Simple key-value for v1, can evolve to SQLite later if needed.

## New Files

| File | Purpose |
|------|---------|
| `src/core/plugin-manager-v2.ts` | PluginManagerV2 — load, setup, teardown, command registry |
| `src/core/plugin-context.ts` | PluginContext implementation |
| `src/core/plugin-storage.ts` | PluginStorage (JSON file per plugin) |
| `src/core/plugin-types.ts` | OpenACPPlugin, PluginContext, CommandDef interfaces |
| `src/core/plugin-compat.ts` | v1 AdapterFactory → v2 OpenACPPlugin wrapper |
| `src/core/__tests__/plugin-manager-v2.test.ts` | Plugin lifecycle, error isolation tests |
| `src/core/__tests__/plugin-context.test.ts` | Events, commands, middleware tests |
| `src/core/__tests__/plugin-storage.test.ts` | Storage persistence tests |

## Modified Files

| File | Change |
|------|--------|
| `src/core/config.ts` | Add `plugins` array to Zod schema with defaults |
| `src/main.ts` | Plugin phase in startup lifecycle |
| `src/core/channel.ts` | Add `registerPluginCommands()` to ChannelAdapter |
| `src/core/event-bus.ts` | Add plugin-relevant events (agent:prompt, adapter:outgoing) |
| `src/core/session-bridge.ts` | Emit agent:prompt event, run middleware hooks |
| `src/core/index.ts` | Export plugin types for npm consumers |
| `src/cli/commands.ts` | Add `openacp plugin add/remove/list` commands |
| `src/adapters/telegram/adapter.ts` | Implement registerPluginCommands() |
| `src/adapters/discord/adapter.ts` | Implement registerPluginCommands() |

## Scope Estimate

- ~1500-2000 lines new code (core plugin system)
- ~300 lines modifications to existing files
- ~500 lines tests
- Suitable for 2-3 PRs:
  1. Core plugin system (types, manager, context, storage, compat)
  2. Adapter integration (command registration, middleware hooks)
  3. CLI commands + documentation

## Out of Scope (v2.0)

- Plugin sandboxing / permission model (plugins have full process access)
- Plugin dependency resolution (manual ordering via config)
- Plugin marketplace / registry (install from npm directly)
- Hot-reload (plugins loaded at startup only, restart to add/remove)
- Plugin-to-plugin communication (use EventBus for now)

## Future Improvements

- **Plugin marketplace**: `openacp plugin search <keyword>` — browse community plugins
- **Hot-reload**: Add/remove plugins without restart
- **Plugin config UI**: Web UI or Telegram command to configure plugin settings
- **Plugin templates**: `openacp plugin create <name>` — scaffold a new plugin project
- **Plugin SDK**: `@openacp/plugin-sdk` — utilities, testing helpers, type-safe context
