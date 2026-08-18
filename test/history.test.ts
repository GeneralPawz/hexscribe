/**
 * What a finished job leaves behind.
 *
 * `history.ts` writes a run three times — when it starts, once per utterance,
 * and when it settles — and the last of those is an upsert carrying everything
 * the job was told at the beginning. That is fine until somebody touches the run
 * while it is still decoding, which the rail now lets them do: rename it, or
 * delete it. Both of those are undone by a naive settle write, and both fail
 * *later*, quietly, when the run finishes and the list refreshes itself.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as asrPlugin from '../src/asr.ts'
import * as jobsPlugin from '../src/jobs.ts'
import * as storePlugin from '../src/store.ts'
import * as historyPlugin from '../src/history.ts'
import type { AsrEngine, Segment, TranscribeRequest, Transcript } from '../src/asr.ts'

const seg = (index: number, start: number, end: number): Segment => ({
  index,
  start,
  end,
  text: `t${index}`,
})

/** An engine that finishes when the test says so, and not before. */
function scriptedEngine() {
  let release: (value: Transcript | Error) => void = () => {}
  let started: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    started = resolve
  })

  const engine: AsrEngine = {
    name: 'scripted',
    async describe() {
      return {}
    },
    async transcribe(_request: TranscribeRequest): Promise<Transcript> {
      started()
      const settled = await new Promise<Transcript | Error>((resolve) => {
        release = resolve
      })
      if (settled instanceof Error) throw settled
      return settled
    },
  }

  return {
    engine,
    running,
    finish: (transcript: Transcript) => release(transcript),
  }
}

const transcript = (): Transcript => ({
  engine: 'scripted',
  model: 'scripted',
  segments: [seg(0, 0, 30)],
  text: 't0',
  timing: { audio_seconds: 30, total_ms: 1, rtf: 0 },
})

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'hexscribe-history-'))
  const script = scriptedEngine()
  const ctx = new Context()
  await ctx.plugin(asrPlugin, { default: 'scripted' })
  await ctx.plugin({
    name: 'engine',
    inject: ['asr'],
    apply: (inner: Context) => inner.asr.register(script.engine),
  })
  await ctx.plugin(storePlugin, { path: join(directory, 'history.db') })
  await ctx.plugin(jobsPlugin, { retainMinutes: 60, maxJobs: 50 })
  await ctx.plugin(historyPlugin)
  return {
    ctx,
    script,
    dispose: async () => {
      await ctx.root.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

const request = (): TranscribeRequest => ({ path: 'a.wav', task: 'transcribe' })

/** Settling is asynchronous; the listener runs on the emit, not on the tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test('a run renamed while it is decoding keeps the name it was given', async (t) => {
  // The rail lets a run be renamed the moment it appears, which is while it is
  // still running. The settle write carries the filename the job started with,
  // so this reverted a few minutes later -- long after the person had looked
  // away, and with nothing to suggest it had happened.
  const app = await harness()
  t.after(app.dispose)

  const job = app.ctx.jobs.start(request(), { name: 'rec_0042.m4a' })
  await app.script.running
  await settle()

  assert.equal(app.ctx.store.getRun(job.id)?.name, 'rec_0042.m4a', 'it starts as the filename')
  assert.equal(app.ctx.store.renameRun(job.id, 'Kitchen argument'), true)

  app.script.finish(transcript())
  await settle()

  const done = app.ctx.store.getRun(job.id)
  assert.equal(done?.status, 'done', 'the run finished normally')
  assert.equal(done?.name, 'Kitchen argument', 'and is still called what it was renamed to')
})

test('a run deleted while it is decoding does not come back when it finishes', async (t) => {
  // The settle write is an upsert, so without a guard the row reappears at the
  // end -- a delete that undoes itself, which is worse than one that refuses.
  const app = await harness()
  t.after(app.dispose)

  const job = app.ctx.jobs.start(request(), { name: 'a.wav' })
  await app.script.running
  await settle()

  assert.equal(app.ctx.store.deleteRun(job.id), true)
  assert.equal(app.ctx.store.hasRun(job.id), false)

  app.script.finish(transcript())
  await settle()

  assert.equal(app.ctx.store.hasRun(job.id), false, 'still gone')
  assert.deepEqual(app.ctx.store.listRuns(), [], 'and the list is empty, not one row long')
})
