#!/usr/bin/env node
/**
 * Launcher for the HTTP front-end.
 *
 * `cordis.yml` gates `cli` and `serve` on HEXSCRIBE_SERVE so one composition can
 * be either a one-shot command or a long-running server. Turning CLI flags into
 * environment for that gate is a launcher's job, which is why the serve plugin
 * itself reads nothing but its config.
 *
 *   node --import tsx scripts/serve.mjs [--port 9000] [--host 127.0.0.1] [--api-key KEY] [--db FILE]
 */

import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    'api-key': { type: 'string' },
    db: { type: 'string' },
  },
})

process.env.HEXSCRIBE_SERVE = '1'
if (values.port) process.env.HEXSCRIBE_PORT = String(values.port)
if (values.host) process.env.HEXSCRIBE_HOST = String(values.host)
if (values['api-key']) process.env.HEXSCRIBE_API_KEY = String(values['api-key'])
// A scratch database, for trying things without risking the real one.
if (values.db) process.env.HEXSCRIBE_DB = String(values.db)

// The package exports map has no "./bin.js" entry, so resolve it by path.
const loader = resolve(process.cwd(), 'node_modules/@deepseek-ai/cordis/bin.js')
await import(pathToFileURL(loader).href)
