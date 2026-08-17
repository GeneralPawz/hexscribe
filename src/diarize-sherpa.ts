import type { Context } from '@deepseek-ai/cordis'
import type {} from './diarize.ts'
import type {} from './worker-python.ts'
import type { DiarizeRequest, DiarizeResult } from './diarize.ts'

/**
 * Diarization backed by sherpa-onnx in the Python worker.
 *
 * Same worker process as the NPU engine: sherpa loads its own ONNX Runtime
 * alongside the QNN one, which was the risk worth measuring before building
 * this (`spikes/05_diarize_probe.py` checks a QNN session still works after
 * sherpa has run). Because the worker answers one request at a time, a
 * diarization run blocks transcription for its duration -- acceptable for a
 * local tool, and the reason a second worker would be the fix if it ever isn't.
 */
export const name = 'diarize-sherpa'
export const inject = ['diarize', 'worker']

export function apply(ctx: Context) {
  ctx.diarize.register({
    name: 'sherpa',

    async describe() {
      const info = await ctx.worker.call<Record<string, unknown>>('info')
      return { engine: 'sherpa', available: info.diarization_available ?? false }
    },

    async diarize(request: DiarizeRequest): Promise<DiarizeResult> {
      const result = await ctx.worker.call<Omit<DiarizeResult, 'engine'>>('diarize', {
        path: request.path,
        threshold: request.threshold,
      })
      return { engine: 'sherpa', ...result }
    },
  })
}
