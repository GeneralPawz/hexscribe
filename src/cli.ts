import { parseArgs } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from './asr.ts'
import type { Segment } from './asr.ts'
import { FORMAT_NAMES, type FormatName, isFormatName, render, srtTimestamp } from './formats.ts'

export interface Config {
  language?: string
  task: 'transcribe' | 'translate'
  format: FormatName
  engine?: string
  timestamps: boolean
}

export const Config: Schema<Config> = Schema.object({
  language: Schema.string().description('Default language code, e.g. de. Omit for auto-detection.'),
  task: Schema.union(['transcribe', 'translate'] as const).default('transcribe'),
  format: Schema.union(FORMAT_NAMES).default('text'),
  engine: Schema.string().description('ASR engine name; omit when only one is loaded.'),
  timestamps: Schema.boolean().default(true).description('Ask the engine for per-utterance times.'),
})

const USAGE = `hexscribe -- local speech to text on the Hexagon NPU

  hexscribe <audio> [options]
  hexscribe --doctor

Options:
  --lang <code>     language code (default: from cordis.yml, else auto-detect)
  --task <t>        transcribe | translate            (default: transcribe)
  --format <f>      text | srt | vtt | json           (default: text)
  --engine <name>   ASR engine to use
  --out <file>      write output to a file instead of stdout
  --no-timestamps   decode whole 30 s windows instead of utterances (faster)
  --diarize         label who is speaking (CPU; costs several times the transcription)
  --no-merge        keep utterances exactly as decoded, split sentences and all
  --quiet           do not stream segments to stderr
  --doctor          report engine/NPU status and exit
`

export const name = 'cli'
export const inject = ['asr']

export function apply(ctx: Context, config: Config) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      lang: { type: 'string' },
      task: { type: 'string' },
      format: { type: 'string' },
      engine: { type: 'string' },
      out: { type: 'string' },
      timestamps: { type: 'boolean' },
      'no-timestamps': { type: 'boolean' },
      diarize: { type: 'boolean' },
      'no-merge': { type: 'boolean' },
      quiet: { type: 'boolean' },
      doctor: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  const log = (line: string) => process.stderr.write(line + '\n')

  const finish = async (code: number) => {
    process.exitCode = code
    // Unwind the application: every plugin's disposers run, which is what stops
    // the Python worker. Nothing here knows a subprocess is involved.
    await ctx.root.fiber.dispose()
  }

  if (!values.quiet) {
    ctx.on('asr/segment', (segment: Segment) => {
      log(`  [${srtTimestamp(segment.start).slice(0, 8)}] ${segment.text.slice(0, 100)}`)
    })
  }

  void (async () => {
    try {
      if (values.help) {
        process.stdout.write(USAGE)
        return finish(0)
      }

      if (values.doctor) {
        await ctx.asr.ready().catch((error) => log(String(error.message)))
        const engines = ctx.asr.list()
        log(`engines: ${engines.join(', ') || '(none)'}`)
        for (const engineName of engines) {
          const info = await ctx.asr.get(engineName)!.describe()
          log(JSON.stringify(info, null, 2))
        }
        return finish(0)
      }

      const [audio] = positionals
      if (!audio) {
        process.stderr.write(USAGE)
        return finish(1)
      }

      const started = Date.now()
      const transcript = await ctx.asr.transcribe({
        path: resolve(process.cwd(), audio),
        language: (values.lang as string) ?? config.language,
        task: ((values.task as string) ?? config.task) as Config['task'],
        engine: (values.engine as string) ?? config.engine,
        // Speaker labels are useless without utterance boundaries to attach
        // them to, so asking for one implies the other.
        timestamps: values['no-timestamps'] && !values.diarize ? false : config.timestamps,
        diarize: Boolean(values.diarize),
        merge: values['no-merge'] ? false : undefined,
      })

      const requested = (values.format as string) ?? config.format
      if (!isFormatName(requested)) {
        throw new Error(`unknown format: ${requested} (expected ${FORMAT_NAMES.join(' | ')})`)
      }
      const { body: output } = render(transcript, requested)
      if (values.out) {
        const target = resolve(process.cwd(), values.out as string)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, output + '\n', 'utf8')
        log(`wrote ${values.out}`)
      } else {
        process.stdout.write(output + '\n')
      }

      const t = transcript.timing
      const detail = [
        `rtf ${t.rtf}`,
        t.encode_ms === undefined ? null : `encode ${t.encode_ms.toFixed(0)}ms`,
        t.ms_per_token === undefined ? null : `decode ${t.ms_per_token}ms/token`,
        t.tokens === undefined ? null : `${t.tokens} tokens`,
        t.diarize_ms === undefined
          ? null
          : `diarize ${(t.diarize_ms / 1000).toFixed(1)}s → ${transcript.speakers?.length ?? 0} speakers`,
      ].filter(Boolean)
      log(
        `\n${transcript.engine}/${transcript.model}: ${t.audio_seconds.toFixed(1)}s audio in ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s wall (${detail.join(', ')})`,
      )
      // Last, so it is the line still on screen: a transcript missing a little
      // audio must not be mistaken for a complete one.
      if (transcript.damage?.skipped_packets) {
        log(
          `warning: skipped ${transcript.damage.skipped_packets} damaged audio packet(s) ` +
            `of ${transcript.damage.total_packets}; a little audio is missing from this transcript`,
        )
      }
      return finish(0)
    } catch (error) {
      log(`error: ${error instanceof Error ? error.message : String(error)}`)
      return finish(1)
    }
  })()
}
