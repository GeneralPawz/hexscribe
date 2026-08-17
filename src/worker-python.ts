import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    worker: PythonWorker
  }
}

export interface Config {
  python: string
  module: string
  cwd: string
  modelDir: string
  tokenizer: string
  startupTimeout: number
  ioBinding: boolean
  segmentationModel?: string
  embeddingModel?: string
  utteranceEmbeddingModel?: string
  diarizationThreads: number
}

export const Config: Schema<Config> = Schema.object({
  python: Schema.string()
    .default('py/.venv/Scripts/python.exe')
    .description('Interpreter for the worker. Must be an ARM64 build: an x64 python under Prism cannot load the QNN DLLs.'),
  module: Schema.string().default('hexscribe_worker.worker'),
  cwd: Schema.string().default('py').description('Working directory, so the worker package resolves.'),
  modelDir: Schema.string().description('Directory holding encoder.onnx, decoder.onnx and metadata.json.').required(),
  tokenizer: Schema.string().description('Path to the Whisper tokenizer.json.').required(),
  startupTimeout: Schema.number().default(30000).description('Milliseconds to wait for the worker ready line.'),
  ioBinding: Schema.boolean()
    .default(true)
    .description('Reuse bound tensors across decode steps. Worth ~1.5%; false selects the unbound reference path.'),
  segmentationModel: Schema.string().description('Pyannote segmentation ONNX. With embeddingModel, enables diarization.'),
  embeddingModel: Schema.string().description('Speaker embedding ONNX. With segmentationModel, enables diarization.'),
  utteranceEmbeddingModel: Schema.string().description(
    'Speaker embedding ONNX for utterance-level diarization. Needs no segmentation model.',
  ),
  diarizationThreads: Schema.number()
    .default(4)
    .description('CPU threads for diarization. Measured: 4 beats 1 and 8 on a 10-core Snapdragon X Plus.'),
})

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  onEvent?: (event: string, data: any) => void
}

/**
 * Owns the Python NPU worker process.
 *
 * The process is an effect: it starts when this plugin loads and is torn down
 * when it unloads, including on hot reload and on loss of a dependency. Nothing
 * else in the app knows a subprocess exists.
 */
export class PythonWorker extends Service {
  static readonly inject = []

  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private nextId = 1
  private ready?: Promise<Record<string, unknown>>
  private exited = false

  constructor(
    ctx: Context,
    public config: Config,
  ) {
    super(ctx, 'worker')

    ctx.effect(() => {
      this.start()
      return async () => {
        await this.stop()
      }
    }, 'python-worker-process')
  }

  private start() {
    const python = resolve(process.cwd(), this.config.python)
    const cwd = resolve(process.cwd(), this.config.cwd)
    const args = [
      '-m',
      this.config.module,
      '--model-dir',
      resolve(process.cwd(), this.config.modelDir),
      '--tokenizer',
      resolve(process.cwd(), this.config.tokenizer),
      ...(this.config.ioBinding ? [] : ['--no-io-binding']),
      // Both or neither: the worker only enables diarization when it has both models.
      ...(this.config.segmentationModel && this.config.embeddingModel
        ? [
            '--segmentation-model',
            resolve(process.cwd(), this.config.segmentationModel),
            '--embedding-model',
            resolve(process.cwd(), this.config.embeddingModel),
            '--diarization-threads',
            String(this.config.diarizationThreads),
          ]
        : []),
      // Independent of the pair above: clustering utterances needs an embedding
      // model and nothing else, so it can be enabled on its own.
      ...(this.config.utteranceEmbeddingModel
        ? [
            '--utterance-embedding-model',
            resolve(process.cwd(), this.config.utteranceEmbeddingModel),
          ]
        : []),
    ]

    const child = spawn(python, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.exited = false

    this.ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(
        () => rejectReady(new Error(`worker did not report ready within ${this.config.startupTimeout}ms`)),
        this.config.startupTimeout,
      )
      const onReady = (info: Record<string, unknown>) => {
        clearTimeout(timer)
        resolveReady(info)
      }
      this.onReady = onReady
      child.once('error', (error) => {
        clearTimeout(timer)
        rejectReady(new Error(`failed to spawn ${python}: ${error.message}`))
      })
    })
    // A rejection with no consumer yet would crash the process on some Node
    // versions; the real error still surfaces from call().
    this.ready.catch(() => {})

    const stdout = createInterface({ input: child.stdout })
    stdout.on('line', (line) => this.handleLine(line))

    const stderr = createInterface({ input: child.stderr })
    stderr.on('line', (line) => {
      // QNN's backend prints DSP_INFO chatter on every session; keep it at debug.
      this.ctx.logger?.debug?.(line)
    })

    child.on('exit', (code, signal) => {
      this.exited = true
      const reason = new Error(`worker exited (code=${code}, signal=${signal})`)
      for (const [, pending] of this.pending) pending.reject(reason)
      this.pending.clear()
    })
  }

  private onReady?: (info: Record<string, unknown>) => void

  private handleLine(line: string) {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      // Native libraries occasionally write to stdout; never let that be fatal.
      this.ctx.logger?.debug?.(`non-protocol stdout: ${line.slice(0, 160)}`)
      return
    }

    if (message.event === 'ready' && message.id === undefined) {
      this.onReady?.(message.data ?? {})
      return
    }

    const pending = this.pending.get(message.id)
    if (!pending) return

    if (message.event) {
      pending.onEvent?.(message.event, message.data)
      return
    }
    this.pending.delete(message.id)
    if (message.error) {
      const error = new Error(message.error.message ?? 'worker error')
      ;(error as any).code = message.error.code
      pending.reject(error)
    } else {
      pending.resolve(message.result)
    }
  }

  /** Wait for the worker to be up; resolves to its startup info. */
  async whenReady(): Promise<Record<string, unknown>> {
    if (!this.ready) throw new Error('worker not started')
    return this.ready
  }

  /** Issue one request. `onEvent` receives streamed events for this request only. */
  async call<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    onEvent?: (event: string, data: any) => void,
  ): Promise<T> {
    await this.whenReady()
    if (!this.child || this.exited) throw new Error('worker is not running')

    const id = this.nextId++
    return new Promise<T>((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, onEvent })
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  private async stop() {
    const child = this.child
    if (!child || this.exited) return
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    try {
      child.stdin.write(JSON.stringify({ id: 0, method: 'shutdown' }) + '\n')
      child.stdin.end()
    } catch {
      // already gone
    }
    const timer = setTimeout(() => child.kill(), 2000)
    await exited
    clearTimeout(timer)
  }
}

export const name = 'worker-python'

export function apply(ctx: Context, config: Config) {
  ctx.plugin(PythonWorker, config)
}
