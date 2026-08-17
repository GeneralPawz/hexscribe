/**
 * Transcriptions that outlive the request that asked for them.
 *
 * What matters here is what a poller is told. A job that reports a percentage it
 * invented, or forgets to release the upload it was holding, or leaves a caller
 * waiting on a run that has already failed, is worse than no background mode —
 * the caller has no other way to find out.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as asrPlugin from '../src/asr.ts'
import * as jobsPlugin from '../src/jobs.ts'
import type { AsrEngine, Segment, TranscribeRequest, Transcript } from '../src/asr.ts'

const seg = (index: number, start: number, end: number): Segment => ({
  index,
  start,
  end,
  text: `t${index}`,
})

/**
 * An engine under the test's control: it streams what it is told to, when it is
 * told to, and finishes when released.
 */
function scriptedEngine() {
  let release: (value: Transcript | Error) => void = () => {}
  let emit: (segment: Segment) => void = () => {}
  let announce: (seconds: number) => void = () => {}
  let started: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    started = resolve
  })

  const engine: AsrEngine = {
    name: 'scripted',
    async describe() {
      return {}
    },
    async transcribe(request: TranscribeRequest, onSegment: (segment: Segment) => void) {
      emit = onSegment
      // The real engine emits this on the context, not through onSegment; the
      // service is registered by then, so the event reaches it either way.
      announce = (seconds) => ctxRef!.emit('asr/audio', seconds, request)
      started()
      const settled = await new Promise<Transcript | Error>((resolve) => {
        release = resolve
      })
      if (settled instanceof Error) throw settled
      return settled
    },
  }

  let ctxRef: Context | undefined
  return {
    engine,
    running,
    attach: (ctx: Context) => (ctxRef = ctx),
    segment: (s: Segment) => emit(s),
    duration: (seconds: number) => announce(seconds),
    finish: (transcript: Transcript) => release(transcript),
    fail: (message: string) => release(new Error(message)),
  }
}

const transcript = (segments: Segment[], audioSeconds: number): Transcript => ({
  engine: 'scripted',
  model: 'scripted',
  segments,
  text: segments.map((s) => s.text).join(' '),
  timing: { audio_seconds: audioSeconds, total_ms: 1, rtf: 0 },
})

async function harness(config: Partial<jobsPlugin.Config> = {}) {
  const script = scriptedEngine()
  const ctx = new Context()
  await ctx.plugin(asrPlugin, { default: 'scripted' })
  await ctx.plugin({
    name: 'engine',
    inject: ['asr'],
    apply: (inner: Context) => inner.asr.register(script.engine),
  })
  await ctx.plugin(jobsPlugin, { retainMinutes: 60, maxJobs: 50, ...config })
  script.attach(ctx)
  return { ctx, script, dispose: () => ctx.root.fiber.dispose() }
}

const request = (): TranscribeRequest => ({ path: 'a.wav', task: 'transcribe' })

test('starting a job answers immediately, before any work is done', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const job = app.ctx.jobs.start(request(), { name: 'a.wav' })

  assert.equal(job.status, 'running')
  assert.ok(job.id.length > 10, 'with an id to come back with')
  assert.equal(job.name, 'a.wav')
  assert.deepEqual(job.progress, { seconds: 0, segments: 0 })

  app.script.fail('done with it')
})

test('progress is measured, and a percentage appears only once it can be', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const job = app.ctx.jobs.start(request(), { name: 'a.wav' })
  await app.script.running

  // Before the file has been decoded there is no duration. Reporting a fraction
  // here would mean inventing the denominator.
  app.script.segment(seg(0, 0, 30))
  assert.equal(app.ctx.jobs.get(job.id)!.progress.seconds, 30)
  assert.equal(app.ctx.jobs.get(job.id)!.progress.fraction, undefined, 'no duration, no percentage')

  app.script.duration(300)
  const withDuration = app.ctx.jobs.get(job.id)!.progress
  assert.equal(withDuration.duration, 300)
  assert.equal(withDuration.fraction, 0.1, '30 s of 300 is a tenth, not an estimate of one')

  app.script.segment(seg(1, 30, 150))
  assert.equal(app.ctx.jobs.get(job.id)!.progress.fraction, 0.5)
  assert.equal(app.ctx.jobs.get(job.id)!.progress.segments, 2)

  app.script.finish(transcript([seg(0, 0, 30), seg(1, 30, 150)], 300))
})

test('progress never goes backwards, whatever order segments arrive in', async (t) => {
  // Post-processing can merge utterances and renumber them; a display that
  // jumped back to 20% would read as the run having restarted.
  const app = await harness()
  t.after(app.dispose)

  const job = app.ctx.jobs.start(request(), { name: 'a.wav' })
  await app.script.running
  app.script.duration(300)

  app.script.segment(seg(0, 0, 200))
  app.script.segment(seg(1, 10, 20))

  assert.equal(app.ctx.jobs.get(job.id)!.progress.seconds, 200)
  app.script.fail('enough')
})

test('a finished job holds the transcript, and says it is finished', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const job = app.ctx.jobs.start(request(), { name: 'interview.mp3' })
  await app.script.running
  app.script.finish(transcript([seg(0, 0, 30), seg(1, 30, 60)], 60))
  await new Promise((resolve) => setTimeout(resolve, 10))

  const done = app.ctx.jobs.get(job.id)!
  assert.equal(done.status, 'done')
  assert.equal(done.transcript?.segments.length, 2)
  assert.ok(done.finished! >= done.created)
  assert.equal(done.progress.fraction, 1, 'a finished job is finished, not 97%')
  assert.equal(done.progress.segments, 2)
})

test('a failure is recorded on the job rather than thrown at nobody', async (t) => {
  // `start` returns synchronously and the run continues without an awaiter, so
  // a rejection has nowhere to go but here. A poller must be able to see it.
  const app = await harness()
  t.after(app.dispose)

  const job = app.ctx.jobs.start(request(), { name: 'broken.mp3' })
  await app.script.running
  app.script.fail('the file looks damaged')
  await new Promise((resolve) => setTimeout(resolve, 10))

  const failed = app.ctx.jobs.get(job.id)!
  assert.equal(failed.status, 'failed')
  assert.match(failed.error ?? '', /damaged/)
  assert.equal(failed.transcript, undefined)
})

test('the upload is released however the job ends', async (t) => {
  // The request that saved the file has long returned, so nothing else can.
  for (const outcome of ['done', 'failed'] as const) {
    const app = await harness()
    let released = 0

    app.ctx.jobs.start(request(), { name: 'a.wav', cleanup: () => void released++ })
    await app.script.running
    if (outcome === 'done') app.script.finish(transcript([seg(0, 0, 1)], 1))
    else app.script.fail('no')
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(released, 1, `cleanup ran for a ${outcome} job`)
    await app.dispose()
  }
})

test('two jobs do not report each others progress', async (t) => {
  // The join between an event about a request and the job that asked for it is
  // the request object itself. Getting that wrong would show one file's
  // progress under another file's name.
  const first = await harness()
  t.after(first.dispose)

  const requestA = request()
  const requestB = { ...request(), path: 'b.wav' }
  const jobA = first.ctx.jobs.start(requestA, { name: 'a.wav' })
  const jobB = first.ctx.jobs.start(requestB, { name: 'b.wav' })

  first.ctx.emit('asr/audio', 100, requestA)
  first.ctx.emit('asr/segment', seg(0, 0, 50), requestA)

  assert.equal(first.ctx.jobs.get(jobA.id)!.progress.fraction, 0.5)
  assert.equal(first.ctx.jobs.get(jobB.id)!.progress.seconds, 0, 'B heard nothing about A')
  assert.equal(first.ctx.jobs.get(jobB.id)!.progress.fraction, undefined)

  first.script.fail('done')
})

test('finished jobs are swept, running ones never are', async (t) => {
  const app = await harness({ retainMinutes: 0, maxJobs: 1 })
  t.after(app.dispose)

  const old = app.ctx.jobs.start(request(), { name: 'old.wav' })
  await app.script.running
  app.script.finish(transcript([seg(0, 0, 1)], 1))
  await new Promise((resolve) => setTimeout(resolve, 20))

  const second = app.ctx.jobs.start({ ...request(), path: 'b.wav' }, { name: 'new.wav' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(app.ctx.jobs.get(old.id), undefined, 'the finished one aged out')
  assert.equal(app.ctx.jobs.get(second.id)?.status, 'running', 'the running one stayed')

  app.script.fail('done')
})

test('forgetting a job is immediate and final', async (t) => {
  const app = await harness()
  t.after(app.dispose)

  const job = app.ctx.jobs.start(request(), { name: 'a.wav' })
  await app.script.running
  app.script.finish(transcript([seg(0, 0, 1)], 1))
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(app.ctx.jobs.forget(job.id), true)
  assert.equal(app.ctx.jobs.get(job.id), undefined)
  assert.equal(app.ctx.jobs.forget(job.id), false, 'and says so when there was nothing')
})

test('unloading the plugin stops it reporting on runs it can no longer see', async (t) => {
  // The worker owns the run and dies with its own plugin; what must not happen
  // is this service writing to state after its fiber is gone.
  const app = await harness()
  const job = app.ctx.jobs.start(request(), { name: 'a.wav' })
  await app.script.running

  await app.dispose()
  app.script.finish(transcript([seg(0, 0, 1)], 1))
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(job.status, 'running', 'the record was left as it was, not rewritten after disposal')
})
