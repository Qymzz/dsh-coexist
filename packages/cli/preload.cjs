const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const logFile =
  process.env.DSH_COEXIST_LOG ??
  path.join(os.homedir(), '.dsh', 'coexist', 'desktop', 'preload.log')

function log(message) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // Logging must never break the host.
  }
}

log(
  `preload.cjs start argv=${JSON.stringify(process.argv)} ` +
    `electronRunAsNode=${process.env.ELECTRON_RUN_AS_NODE ?? ''} ` +
    `nodeOptions=${process.env.NODE_OPTIONS ? 'yes' : 'no'}`,
)

import(pathToFileURL(path.join(__dirname, 'preload.mjs')).href).catch((err) => {
  log(`preload.cjs failed: ${err.stack ?? err}`)
})
