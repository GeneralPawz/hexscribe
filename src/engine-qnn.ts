import type { Context } from '@deepseek-ai/cordis'
import type {} from './asr.ts'
import type {} from './worker-python.ts'
import type { Segment, Transcript, TranscribeRequest } from './asr.ts'

/**
 * The Hexagon NPU engine.
 *
 * It is deliberately thin: everything model-specific lives in the Python worker,
 * everything policy-related lives in `asr`. What this plugin contributes is one
 * name in `ctx.asr` -- so choosing NPU over CPU over a remote API is a line in
 * cordis.yml, not a branch in any consumer.
 */
export const name = 'engine-qnn'
export const inject = ['asr', 'worker']

export function apply(ctx: Context) {
  ctx.asr.register({
    name: 'qnn',

    async describe() {
      const info = await ctx.worker.call<Record<string, unknown>>('info')
      return { engine: 'qnn', ...info }
    },

    async transcribe(request: TranscribeRequest, onSegment: (segment: Segment) => void): Promise<Transcript> {
      const result = await ctx.worker.call<Omit<Transcript, 'engine'>>(
        'transcribe',
        {
          path: request.path,
          language: request.language ?? null,
          task: request.task,
          timestamps: request.timestamps ?? true,
          resume_from: request.resumeFrom ?? 0,
          first_index: request.firstIndex ?? 0,
        },
        (event, data) => {
          if (event === 'segment') onSegment(data as Segment)
          // Emitted directly rather than routed through `onSegment`: it is not a
          // segment, and widening that callback for one number would make every
          // engine implement a thing only a local one can answer.
          else if (event === 'audio') {
            ctx.emit('asr/audio', (data as { seconds: number }).seconds, request)
          }
        },
      )
      return { engine: 'qnn', ...result }
    },
  })
}
