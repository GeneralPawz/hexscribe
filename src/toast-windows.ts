import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from './jobs.ts'
import type { Job } from './jobs.ts'

export interface Config {
  everyMs: number
  minPercent: number
}

export const Config: Schema<Config> = Schema.object({
  everyMs: Schema.number().default(2000).description('Shortest gap between progress updates.'),
  minPercent: Schema.number().default(1).description('Smallest change worth an update.'),
})

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'toast.ps1')

const clock = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds))
  const parts = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
  return total >= 3600
    ? `${parts[0]}:${String(parts[1]).padStart(2, '0')}:${String(parts[2]).padStart(2, '0')}`
    : `${parts[1]}:${String(parts[2]).padStart(2, '0')}`
}

/**
 * A Windows notification whose progress bar actually moves.
 *
 * The web Notifications API has no progress element and no way to update one
 * quietly — replacing a notification re-inserts it at the top of the Action
 * Center, which at one update a second is a panel that never sits still. That
 * was the flicker.
 *
 * Windows itself does have what was wanted: an *adaptive toast* carrying a
 * `<progress>` bar, whose bound values can be rewritten in place with
 * `ToastNotifier.Update()` — silently, no banner, no re-ordering. Only a native
 * process can send one, which a web page is not. This server, however, is a
 * native process running on the same machine, so it sends the toast on the
 * page's behalf.
 *
 * That has a consequence worth the whole plugin: it works with **no browser tab
 * open at all**. The tab was the one thing the web notification could not
 * survive; this one is driven by the thing doing the work.
 *
 * A long-lived PowerShell process rather than one per update — starting
 * PowerShell costs a couple of hundred milliseconds and this moves a progress
 * bar. It borrows PowerShell's own AppUserModelID, which is the documented way
 * for a program without an installer to notify at all.
 *
 * Windows only, obviously. Elsewhere this refuses to load and says so, and the
 * browser notification remains what there is.
 */
export const name = 'toast-windows'
export const inject = ['jobs']

export function apply(ctx: Context, config: Config) {
  if (process.platform !== 'win32') {
    ctx.logger?.info?.('toast-windows: not Windows, so no toasts from the server')
    return
  }

  let child: ChildProcess | undefined
  let broken = false

  const send = (message: Record<string, unknown>) => {
    if (broken) return
    try {
      if (!child || child.exitCode !== null) child = start()
      child.stdin?.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      // A notification is never worth taking a transcription down with it.
      broken = true
      ctx.logger?.warn?.(`toast-windows: giving up on toasts (${error})`)
    }
  }

  function start(): ChildProcess {
    const spawned = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
    )
    spawned.stderr?.on('data', (chunk) => ctx.logger?.debug?.(`toast: ${String(chunk).trim()}`))
    spawned.on('error', (error) => {
      broken = true
      ctx.logger?.warn?.(`toast-windows: ${error.message}`)
    })
    return spawned
  }

  // One tag per job, so two runs at once are two toasts rather than a fight
  // over one.
  const lastUpdate = new Map<string, { at: number; percent: number }>()

  ctx.on('job/started', (job: Job) => {
    lastUpdate.set(job.id, { at: Date.now(), percent: -1 })
    send({
      op: 'show',
      tag: job.id,
      title: job.name,
      status: 'Transcribing',
      value: 0,
      detail: 'reading the file',
    })
  })

  ctx.on('job/progress', (job: Job) => {
    const seen = lastUpdate.get(job.id)
    if (!seen) return
    const fraction = job.progress.fraction
    // No duration yet means no honest bar to draw; the toast keeps saying it is
    // reading the file, which is what it is doing.
    if (fraction === undefined) return

    const percent = Math.round(fraction * 100)
    const now = Date.now()
    if (now - seen.at < config.everyMs && percent - seen.percent < config.minPercent) return
    lastUpdate.set(job.id, { at: now, percent })

    send({
      op: 'update',
      tag: job.id,
      status: 'Transcribing',
      value: Math.min(1, Math.max(0, fraction)),
      detail: `${clock(job.progress.seconds)} of ${clock(job.progress.duration ?? 0)}`,
    })
  })

  ctx.on('job/settled', (job: Job) => {
    lastUpdate.delete(job.id)
    if (job.status === 'failed') {
      send({ op: 'finish', tag: job.id, title: `${job.name} failed`, detail: job.error ?? 'unknown error' })
      return
    }
    const seconds = job.transcript?.timing.audio_seconds ?? job.progress.duration ?? 0
    const wall = ((job.finished ?? Date.now()) - job.created) / 1000
    send({
      op: 'finish',
      tag: job.id,
      title: `Transcribed ${job.name}`,
      detail: `${job.transcript?.segments.length ?? 0} utterances · ${clock(seconds)} in ${wall.toFixed(0)}s`,
    })
  })

  ctx.effect(() => () => {
    // Closing stdin ends the reader loop, which ends the process.
    child?.stdin?.end()
    child = undefined
  }, 'toast-process')
}
