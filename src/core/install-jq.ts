import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createChildLogger } from './log.js'

const log = createChildLogger({ module: 'jq-install' })

const BIN_DIR = path.join(os.homedir(), '.openacp', 'bin')
const IS_WINDOWS = os.platform() === 'win32'
const BIN_NAME = IS_WINDOWS ? 'jq.exe' : 'jq'
const BIN_PATH = path.join(BIN_DIR, BIN_NAME)

const GITHUB_BASE_URL = 'https://github.com/jqlang/jq/releases/latest/download'

const PLATFORM_MAPPINGS: Record<string, Record<string, string>> = {
  darwin: {
    x64: 'jq-macos-amd64',
    arm64: 'jq-macos-arm64',
  },
  win32: {
    x64: 'jq-windows-amd64.exe',
  },
  linux: {
    x64: 'jq-linux-amd64',
    arm64: 'jq-linux-arm64',
  },
}

function getDownloadUrl(): string {
  const platform = os.platform()
  const arch = os.arch()
  const mapping = PLATFORM_MAPPINGS[platform]
  if (!mapping) throw new Error(`Unsupported platform: ${platform}`)
  const binary = mapping[arch]
  if (!binary) throw new Error(`Unsupported architecture: ${arch} for ${platform}`)
  return `${GITHUB_BASE_URL}/${binary}`
}

function downloadFile(url: string, dest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)

    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close()
        fs.unlinkSync(dest)
        downloadFile(response.headers.location!, dest).then(resolve).catch(reject)
        return
      }

      if (response.statusCode !== 200) {
        file.close()
        fs.unlinkSync(dest)
        reject(new Error(`Download failed with status ${response.statusCode}`))
        return
      }

      response.pipe(file)
      file.on('finish', () => file.close(() => resolve(dest)))
      file.on('error', (err) => {
        file.close()
        if (fs.existsSync(dest)) fs.unlinkSync(dest)
        reject(err)
      })
    }).on('error', (err) => {
      file.close()
      if (fs.existsSync(dest)) fs.unlinkSync(dest)
      reject(err)
    })
  })
}

/**
 * Ensure jq binary is available.
 * 1. Check if already installed in PATH
 * 2. Check if downloaded to ~/.openacp/bin/
 * 3. If not, download from GitHub releases
 */
export async function ensureJq(): Promise<string> {
  // 1. Check PATH
  try {
    const systemPath = execSync('which jq', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    if (systemPath) {
      log.debug({ path: systemPath }, 'jq found in PATH')
      return systemPath
    }
  } catch {
    // Not in PATH
  }

  // 2. Check our bin directory
  if (fs.existsSync(BIN_PATH)) {
    if (!IS_WINDOWS) fs.chmodSync(BIN_PATH, '755')
    log.debug({ path: BIN_PATH }, 'jq found in ~/.openacp/bin')
    return BIN_PATH
  }

  // 3. Download
  log.info('jq not found, downloading from GitHub...')
  fs.mkdirSync(BIN_DIR, { recursive: true })

  const url = getDownloadUrl()
  await downloadFile(url, BIN_PATH)

  if (!IS_WINDOWS) {
    fs.chmodSync(BIN_PATH, '755')
  }

  log.info({ path: BIN_PATH }, 'jq installed successfully')
  return BIN_PATH
}
