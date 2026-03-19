import { execSync } from 'node:child_process'

// --- Telegram validation ---

export async function validateBotToken(token: string): Promise<
  { ok: true; botName: string; botUsername: string } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const data = await res.json() as { ok: boolean; result?: { first_name: string; username: string }; description?: string }
    if (data.ok && data.result) {
      return { ok: true, botName: data.result.first_name, botUsername: data.result.username }
    }
    return { ok: false, error: data.description || 'Invalid token' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function validateChatId(token: string, chatId: number): Promise<
  { ok: true; title: string; isForum: boolean } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    })
    const data = await res.json() as {
      ok: boolean
      result?: { title: string; type: string; is_forum?: boolean }
      description?: string
    }
    if (!data.ok || !data.result) {
      return { ok: false, error: data.description || 'Invalid chat ID' }
    }
    if (data.result.type !== 'supergroup') {
      return { ok: false, error: `Chat is "${data.result.type}", must be a supergroup` }
    }
    return { ok: true, title: data.result.title, isForum: data.result.is_forum === true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// --- Agent detection ---

const KNOWN_AGENTS: Array<{ name: string; commands: string[] }> = [
  { name: 'claude', commands: ['claude-agent-acp', 'claude', 'claude-code'] },
  { name: 'codex', commands: ['codex'] },
]

export async function detectAgents(): Promise<Array<{ name: string; command: string }>> {
  const found: Array<{ name: string; command: string }> = []
  for (const agent of KNOWN_AGENTS) {
    for (const cmd of agent.commands) {
      try {
        execSync(`command -v ${cmd}`, { stdio: 'pipe' })
        found.push({ name: agent.name, command: cmd })
        break // found one for this agent, skip alternatives
      } catch {
        // not found, try next
      }
    }
  }
  return found
}

export async function validateAgentCommand(command: string): Promise<boolean> {
  try {
    execSync(`command -v ${command}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
