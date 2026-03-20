#!/usr/bin/env node

import { installPlugin, uninstallPlugin, listPlugins } from './core/plugin-manager.js'

const args = process.argv.slice(2)
const command = args[0]

function printHelp(): void {
  console.log(`
OpenACP - Self-hosted bridge for AI coding agents

Usage:
  openacp                              Start (mode from config)
  openacp start                        Start as background daemon
  openacp stop                         Stop background daemon
  openacp status                       Show daemon status
  openacp logs                         Tail daemon log file
  openacp config                       Edit configuration
  openacp install <package>            Install a plugin adapter
  openacp uninstall <package>          Uninstall a plugin adapter
  openacp plugins                      List installed plugins
  openacp --foreground                 Force foreground mode
  openacp --version                    Show version
  openacp --help                       Show this help

Install:
  npm install -g @openacp/cli
`)
}

async function main() {
  if (command === '--help' || command === '-h') {
    printHelp()
    return
  }

  if (command === '--version' || command === '-v') {
    // In published build: read version from own package.json via createRequire
    // In dev: fallback to 'dev'
    try {
      const { createRequire } = await import('node:module')
      const require = createRequire(import.meta.url)
      const pkg = require('../package.json')
      console.log(`openacp v${pkg.version}`)
    } catch {
      console.log('openacp v0.0.0-dev')
    }
    return
  }

  if (command === 'install') {
    const pkg = args[1]
    if (!pkg) {
      console.error('Usage: openacp install <package>')
      process.exit(1)
    }
    installPlugin(pkg)
    return
  }

  if (command === 'uninstall') {
    const pkg = args[1]
    if (!pkg) {
      console.error('Usage: openacp uninstall <package>')
      process.exit(1)
    }
    uninstallPlugin(pkg)
    return
  }

  if (command === 'plugins') {
    const plugins = listPlugins()
    const entries = Object.entries(plugins)
    if (entries.length === 0) {
      console.log('No plugins installed.')
    } else {
      console.log('Installed plugins:')
      for (const [name, version] of entries) {
        console.log(`  ${name}@${version}`)
      }
    }
    return
  }

  if (command === 'start') {
    const { startDaemon, getPidPath } = await import('./core/daemon.js')
    const { ConfigManager } = await import('./core/config.js')
    const cm = new ConfigManager()
    if (await cm.exists()) {
      await cm.load()
      const config = cm.get()
      const result = startDaemon(getPidPath(), config.logging.logDir)
      if ('error' in result) {
        console.error(result.error)
        process.exit(1)
      }
      console.log(`OpenACP daemon started (PID ${result.pid})`)
    } else {
      console.error('No config found. Run "openacp" first to set up.')
      process.exit(1)
    }
    return
  }

  if (command === 'stop') {
    const { stopDaemon } = await import('./core/daemon.js')
    const result = stopDaemon()
    if (result.stopped) {
      console.log(`OpenACP daemon stopped (was PID ${result.pid})`)
    } else {
      console.error(result.error)
      process.exit(1)
    }
    return
  }

  if (command === 'status') {
    const { getStatus } = await import('./core/daemon.js')
    const status = getStatus()
    if (status.running) {
      console.log(`OpenACP is running (PID ${status.pid})`)
    } else {
      console.log('OpenACP is not running')
    }
    return
  }

  if (command === 'logs') {
    const { spawn } = await import('node:child_process')
    const { ConfigManager, expandHome } = await import('./core/config.js')
    const pathMod = await import('node:path')
    const cm = new ConfigManager()
    let logDir = '~/.openacp/logs'
    if (await cm.exists()) {
      await cm.load()
      logDir = cm.get().logging.logDir
    }
    const logFile = pathMod.join(expandHome(logDir), 'openacp.log')
    const tail = spawn('tail', ['-f', '-n', '50', logFile], { stdio: 'inherit' })
    tail.on('error', (err: Error) => {
      console.error(`Cannot tail log file: ${err.message}`)
      process.exit(1)
    })
    return
  }

  if (command === 'config') {
    const { runConfigEditor } = await import('./core/config-editor.js')
    const { ConfigManager } = await import('./core/config.js')
    const cm = new ConfigManager()
    if (!(await cm.exists())) {
      console.error('No config found. Run "openacp" first to set up.')
      process.exit(1)
    }
    await runConfigEditor(cm)
    return
  }

  // Handle --daemon-child (internal flag for background server)
  if (command === '--daemon-child') {
    const { startServer } = await import('./main.js')
    await startServer()
    return
  }

  // Handle --foreground flag
  const forceForeground = command === '--foreground'

  // Reject unknown commands
  if (command && !command.startsWith('-')) {
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exit(1)
  }

  // Default: start server based on config runMode
  const { ConfigManager } = await import('./core/config.js')
  const cm = new ConfigManager()

  // If no config, run setup (which will decide mode)
  if (!(await cm.exists())) {
    const { startServer } = await import('./main.js')
    await startServer()
    return
  }

  await cm.load()
  const config = cm.get()

  if (!forceForeground && config.runMode === 'daemon') {
    // Daemon mode: spawn background process
    const { startDaemon, getPidPath } = await import('./core/daemon.js')
    const result = startDaemon(getPidPath(), config.logging.logDir)
    if ('error' in result) {
      console.error(result.error)
      process.exit(1)
    }
    console.log(`OpenACP daemon started (PID ${result.pid})`)
    return
  }

  // Foreground mode
  const { startServer } = await import('./main.js')
  await startServer()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
