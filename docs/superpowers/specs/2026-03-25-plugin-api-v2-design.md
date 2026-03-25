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

## Security Model

Plugins run in the same Node.js process as OpenACP — they have access to the runtime, environment variables, filesystem, and network. A malicious or compromised plugin can read bot tokens, session data, or execute arbitrary commands. Security must be a first-class concern.

### Threat Model

| Threat | Vector | Impact |
|--------|--------|--------|
| Malicious plugin | User installs untrusted npm package | Full system compromise — read secrets, exfiltrate data, execute commands |
| Supply chain attack | Trusted package compromised upstream | Same as above, harder to detect |
| Over-privileged plugin | Plugin requests more access than needed | Increased attack surface if plugin has vulnerability |
| Data exfiltration | Plugin reads session data, sends to external server | User conversations and bot tokens leaked |
| Plugin impersonation | Malicious plugin claims to be official | User trusts and installs without scrutiny |

### 1. Plugin Manifest & Permission Declaration

Every v2 plugin must declare the permissions it requires in its manifest:

```typescript
interface OpenACPPlugin {
  name: string
  version: string
  description?: string

  /** Required permissions — determines what PluginContext exposes */
  permissions: PluginPermission[]

  setup(ctx: PluginContext): Promise<void>
  teardown?(): Promise<void>
  createAdapter?(core: OpenACPCore, config: ChannelConfig): ChannelAdapter
}

type PluginPermission =
  // Tier 1 — read-only, low risk
  | 'events:read'           // Listen to system events
  | 'sessions:list'         // List active sessions (metadata only)

  // Tier 2 — side effects, medium risk
  | 'commands:register'     // Add slash commands to adapters
  | 'middleware:register'   // Intercept and modify prompts/responses
  | 'storage:write'         // Read/write plugin-scoped storage
  | 'messages:send'         // Send messages to session topics

  // Tier 3 — full access, high risk
  | 'core:access'           // Direct access to OpenACPCore, SessionManager, etc.
  | 'config:read'           // Read OpenACP configuration (may contain tokens)
  | 'adapter:create'        // Act as a channel adapter
```

### 2. Permission Enforcement

PluginContext is constructed based on declared permissions. Undeclared APIs are **not available** — not just warned, but absent:

```typescript
function createPluginContext(plugin: OpenACPPlugin, services: CoreServices): PluginContext {
  const permissions = new Set(plugin.permissions)
  const ctx: PluginContext = {
    log: createPluginLogger(plugin.name),
    pluginConfig: getPluginConfig(plugin.name),
  }

  // Tier 1
  if (permissions.has('events:read')) {
    ctx.on = (event, handler) => eventBus.on(event, handler)
    ctx.off = (event, handler) => eventBus.off(event, handler)
  }
  if (permissions.has('sessions:list')) {
    ctx.sessions = { getActiveSessions: () => sessionManager.getActiveSessions() }
  }

  // Tier 2
  if (permissions.has('commands:register')) {
    ctx.registerCommand = (def) => commandRegistry.register(plugin.name, def)
  }
  if (permissions.has('middleware:register')) {
    ctx.registerMiddleware = (hook, fn) => middlewareRegistry.register(plugin.name, hook, fn)
  }
  if (permissions.has('storage:write')) {
    ctx.storage = createPluginStorage(plugin.name)
  }
  if (permissions.has('messages:send')) {
    ctx.sendMessage = (sessionId, content) => bridge.sendMessage(sessionId, content)
  }

  // Tier 3
  if (permissions.has('core:access')) {
    ctx.core = services.core
    ctx.eventBus = services.eventBus
  }
  if (permissions.has('config:read')) {
    ctx.config = services.config  // read-only proxy
  }

  return ctx
}
```

If a plugin tries to access an API it didn't declare (e.g., `ctx.core` without `core:access`), the property is `undefined` — standard JS behavior, no special error needed. Plugin authors will see the issue during development.

### 3. Installation Consent & Audit

When installing a plugin, `openacp plugin add` displays a clear permission audit:

```
$ openacp plugin add @community/plugin-auto-approve

📦 @community/plugin-auto-approve v1.2.0
   Auto-approve read operations for agents

   Requested permissions:
   ✅ events:read          — Listen to system events
   ✅ commands:register    — Add /autoapprove command
   ⚠️  core:access          — Full access to OpenACP core services

   ⚠️  WARNING: This plugin requests Tier 3 access (core:access).
   It can read bot tokens, session data, and access all core services.
   Only install plugins you trust.

   Publisher: @community (unverified)

   Install? [y/N]
```

For Tier 1-only plugins, the warning is minimal:

```
$ openacp plugin add @openacp/plugin-conversation-log

📦 @openacp/plugin-conversation-log v1.0.0
   Record all conversation events per session

   Requested permissions:
   ✅ events:read          — Listen to system events
   ✅ storage:write        — Store conversation logs
   ✅ commands:register    — Add /history command

   Publisher: @openacp (official ✓)

   Install? [Y/n]
```

### 4. Trusted Publishers

Three trust levels based on npm scope:

| Scope | Trust Level | Install Behavior |
|-------|-------------|------------------|
| `@openacp/*` | Official | Auto-trusted, default Y |
| Verified community | Verified | Show permissions, default Y for Tier 1-2 |
| Everything else | Unverified | Show permissions + warning, default N |

**Verification process** (future): Community publishers submit plugins for review. Verified plugins are listed in an OpenACP plugin registry with signed checksums.

For v2.0, verification is manual — `@openacp/*` is official, everything else shows "unverified" warning.

### 5. Checksum Verification

Protect against supply chain attacks (compromised packages):

```
~/.openacp/plugins/checksums.json
{
  "@openacp/plugin-context-bridge@1.0.0": {
    "sha256": "a1b2c3d4...",
    "verifiedAt": "2026-03-25T10:00:00Z",
    "source": "npm"
  }
}
```

**On install:**
1. Download package from npm
2. Compute SHA-256 of package tarball
3. Store in checksums.json

**On startup:**
1. For each plugin, recompute hash of installed package
2. Compare with stored checksum
3. If mismatch → **refuse to load**, log error:
   ```
   ❌ Plugin @openacp/plugin-context-bridge checksum mismatch!
      Expected: a1b2c3d4...
      Got:      e5f6g7h8...
      The plugin may have been tampered with. Reinstall with:
      openacp plugin add @openacp/plugin-context-bridge --force
   ```

**On update:**
- `openacp plugin update <name>` re-downloads and re-computes checksum
- `--force` flag bypasses checksum check (for development)

### 6. Runtime Guardrails

Even with permissions, add runtime protections:

**A) Network access monitoring (Tier 3 only):**
```typescript
// Wrap plugin setup in a monitoring proxy for Tier 3 plugins
// Log any outbound network connections made during setup
if (plugin.permissions.includes('core:access')) {
  log.warn({ plugin: plugin.name }, 'Plugin has Tier 3 access — monitoring enabled')
}
```

**B) Storage isolation:**
- Plugins can ONLY write to `~/.openacp/plugins/data/<plugin-name>/`
- PluginStorage enforces path prefix — no escape via `../../`
- Storage size limit per plugin (default 50MB, configurable)

**C) Command namespace isolation:**
- Plugin commands are prefixed internally: `plugin:<name>:<command>`
- If two plugins register `/context`, conflict detected at startup → error logged, first-registered wins
- Built-in commands ALWAYS take precedence over plugin commands

**D) Middleware execution timeout:**
```typescript
// Middleware must complete within 5 seconds
const result = await Promise.race([
  middleware.handler(data),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Middleware timeout')), 5000)
  )
])
```

**E) Event handler error budget:**
- If a plugin's event handler throws more than 10 errors in 60 seconds → auto-disable plugin
- Log: "Plugin X disabled due to repeated errors. Re-enable with: openacp plugin enable X"
- Prevents a buggy plugin from flooding logs or degrading performance

### 7. Plugin Audit Command

```bash
openacp plugin audit
```

Shows security overview of all installed plugins:

```
Plugin Security Audit
━━━━━━━━━━━━━━━━━━━━

@openacp/plugin-context-bridge v1.0.0
  Publisher: @openacp (official ✓)
  Permissions: events:read, commands:register, storage:write
  Tier: 2 (medium risk)
  Checksum: ✅ verified
  Errors (24h): 0

@community/plugin-auto-approve v1.2.0
  Publisher: @community (unverified)
  Permissions: events:read, commands:register, core:access
  Tier: 3 (HIGH RISK) ⚠️
  Checksum: ✅ verified
  Errors (24h): 2

unknown-plugin v0.1.0
  Publisher: unknown (unverified) ⚠️
  Permissions: events:read, core:access, config:read
  Tier: 3 (HIGH RISK) ⚠️
  Checksum: ❌ MISMATCH — plugin may be tampered!
  Errors (24h): 47 — AUTO-DISABLED
```

### Security Summary

| Layer | Protection | When |
|-------|-----------|------|
| Permission declaration | Plugin declares what it needs | Plugin development |
| Permission enforcement | PluginContext only exposes declared APIs | Runtime |
| Install consent | User reviews permissions before install | Install time |
| Trusted publishers | `@openacp/*` official, others warned | Install time |
| Checksum verification | Detect tampered packages | Install + startup |
| Storage isolation | Plugins can't write outside their directory | Runtime |
| Command namespace | Prevent command conflicts, built-in priority | Startup |
| Middleware timeout | Prevent hanging middleware | Runtime |
| Error budget | Auto-disable crashy plugins | Runtime |
| Audit command | Security overview of all plugins | On demand |

## Out of Scope (v2.0)

- Plugin dependency resolution (manual ordering via config)
- Plugin marketplace / registry (install from npm directly)
- Hot-reload (plugins loaded at startup only, restart to add/remove)
- Plugin-to-plugin communication (use EventBus for now)
- Full process sandboxing (VM isolation, seccomp, etc.) — Node.js limitation

## Future Improvements

- **Plugin marketplace**: `openacp plugin search <keyword>` — browse community plugins
- **Hot-reload**: Add/remove plugins without restart
- **Plugin config UI**: Web UI or Telegram command to configure plugin settings
- **Plugin templates**: `openacp plugin create <name>` — scaffold a new plugin project
- **Plugin SDK**: `@openacp/plugin-sdk` — utilities, testing helpers, type-safe context
- **Process isolation**: Run untrusted plugins in worker threads or child processes
- **Plugin signing**: Cryptographic signatures from verified publishers
- **Audit logging**: Record all plugin API calls for forensics
