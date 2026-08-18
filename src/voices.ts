import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    voices: VoiceService
  }
}

/** Marker for the one-time import, kept in the database it happened to. */
const IMPORTED = 'voices-imported'

/** A voice the user has named, and the print that recognises it again. */
export interface Voice {
  name: string
  /** L2-normalised speaker embedding: the centroid of everything enrolled so far. */
  embedding: number[]
  /** Seconds of speech behind the print. More is a better description of a voice. */
  seconds: number
  /** How many recordings have contributed. */
  recordings: number
}

/** What one speaker in one transcript sounded like. */
export interface Profile {
  speaker: string
  embedding: number[]
  seconds: number
  utterances: number
}

export interface Match {
  name: string
  distance: number
  /** How much better than the runner-up. A close second is not a match. */
  margin: number
}

export interface Config {
  path: string
  threshold: number
  margin: number
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.string()
    .default('voices.json')
    .description('An older library file to import once, if one is lying around. Voices live in the database now.'),
  threshold: Schema.number()
    .default(0.55)
    .description('Cosine distance under which a voice is the same person. Lower is stricter.'),
  margin: Schema.number()
    .default(0.05)
    .description('How far the best match must beat the runner-up before it counts.'),
})

/** Cosine distance between two L2-normalised vectors. */
export function distance(a: number[], b: number[]): number {
  if (a.length !== b.length) return Infinity
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return 1 - dot
}

/**
 * Combine two prints, weighted by the speech behind each.
 *
 * Enrolling the same person from a second recording should improve the print
 * rather than replace it: a voice heard in two rooms is described better by
 * both than by whichever was most recent. Weighting by duration means a long
 * recording counts for more than a passing remark, and renormalising keeps the
 * result a unit vector so distances stay comparable.
 */
export function blend(a: Voice, embedding: number[], seconds: number): number[] {
  const combined = a.embedding.map((value, i) => value * a.seconds + embedding[i] * seconds)
  const norm = Math.hypot(...combined)
  return norm ? combined.map((value) => value / norm) : a.embedding
}

/**
 * Voices this machine has been told the names of.
 *
 * Diarization can say "these twelve utterances are one person"; it cannot say
 * who that person is, and nothing in the audio will ever tell it. A name comes
 * from a human, once — and the point of storing it against the voice print is
 * that it only has to be given once, because the next recording of the same
 * person can be recognised.
 *
 * Stored in the database with everything else, and that placement is the point.
 * This is biometric data in the sense that matters -- it identifies a specific
 * person by their voice -- and it used to sit in a JSON file beside the code,
 * which meant Settings' "delete the whole database" wiped every transcript and
 * left the voice prints behind. The most sensitive thing here was the one thing
 * that button did not remove.
 *
 * It never leaves the machine, it is backed up by copying the same single file
 * as everything else, and removing this plugin from `cordis.yml` leaves
 * transcription and diarization working exactly as before, with speakers
 * numbered rather than named.
 */
export class VoiceService extends Service {
  private voices = new Map<string, Voice>()
  private loaded: Promise<void>

  constructor(
    ctx: Context,
    public config: Config,
  ) {
    super(ctx, 'voices')
    this.loaded = this.load()
  }

  private get file(): string {
    return resolve(process.cwd(), this.config.path)
  }

  private async load(): Promise<void> {
    for (const voice of this.ctx.store.listVoices()) this.voices.set(voice.name, voice)
    if (!this.voices.size) await this.importOldFile()
  }

  /**
   * Take over a `voices.json` from before the library moved into the database.
   *
   * Once per database, and only into an empty library — recorded in the
   * database rather than by touching the file. An earlier version renamed the
   * file to mark it done, which looked tidy and was dangerous: a second
   * instance run against a scratch database imported the prints, renamed the
   * file, and left the real library with nothing to import and nothing to say
   * about it. The file is never modified now. It is somebody's voice prints,
   * and this code has no business being the last thing holding them.
   */
  private async importOldFile(): Promise<void> {
    if (this.ctx.store.marked(IMPORTED)) return
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return // no file, which is the normal case
    }
    try {
      const stored = JSON.parse(raw) as { voices?: Voice[] }
      let imported = 0
      for (const voice of stored.voices ?? []) {
        if (!voice?.name || !Array.isArray(voice.embedding)) continue
        this.voices.set(voice.name, voice)
        this.ctx.store.saveVoice(voice)
        imported += 1
      }
      if (imported) {
        this.ctx.store.mark(IMPORTED)
        this.ctx.store.log('info', `imported ${imported} voices from ${this.file} into the database`)
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`could not import ${this.file}: ${error}`)
    }
  }

  async ready(): Promise<void> {
    await this.loaded
  }

  async list(): Promise<Array<Omit<Voice, 'embedding'>>> {
    await this.loaded
    // Without the embedding: a caller listing names has no use for 192 floats,
    // and this is the response that goes over the wire most often.
    return [...this.voices.values()].map(({ embedding: _drop, ...rest }) => rest)
  }

  /**
   * Who this voice is, if we have been told.
   *
   * Two conditions, not one. Being close enough is not sufficient when a second
   * voice is nearly as close — on the measured fixtures the same person across
   * recordings sits at 0.12–0.49 and different people at 0.60 and up, which is a
   * real gap but not a wide one, and a confident wrong name is worse than a
   * number. Ambiguity returns nothing.
   */
  async match(embedding: number[]): Promise<Match | undefined> {
    await this.loaded
    const ranked = [...this.voices.values()]
      .map((voice) => ({ name: voice.name, distance: distance(voice.embedding, embedding) }))
      .sort((a, b) => a.distance - b.distance)

    const best = ranked[0]
    if (!best || best.distance > this.config.threshold) return undefined

    const runnerUp = ranked[1]?.distance ?? Infinity
    const margin = runnerUp - best.distance
    if (margin < this.config.margin) return undefined

    return { name: best.name, distance: best.distance, margin }
  }

  /** Name a voice, or teach an existing name what it also sounds like. */
  async enroll(name: string, embedding: number[], seconds: number): Promise<Voice> {
    await this.loaded
    const trimmed = name.trim()
    if (!trimmed) throw new Error('a voice needs a name')
    if (!embedding.length) throw new Error('a voice needs an embedding to be recognised by')

    const existing = this.voices.get(trimmed)
    const voice: Voice = existing
      ? {
          ...existing,
          embedding: blend(existing, embedding, seconds),
          seconds: existing.seconds + seconds,
          recordings: existing.recordings + 1,
        }
      : { name: trimmed, embedding, seconds, recordings: 1 }

    this.voices.set(trimmed, voice)
    this.ctx.store.saveVoice(voice)
    return voice
  }

  /** Rename, keeping the print. What the panel does when a name was a typo. */
  async rename(from: string, to: string): Promise<Voice | undefined> {
    await this.loaded
    const voice = this.voices.get(from)
    const trimmed = to.trim()
    if (!voice || !trimmed) return undefined
    this.voices.delete(from)
    this.voices.set(trimmed, { ...voice, name: trimmed })
    this.ctx.store.renameVoice(from, trimmed)
    return this.voices.get(trimmed)
  }

  async forget(name: string): Promise<boolean> {
    await this.loaded
    const removed = this.voices.delete(name)
    if (removed) this.ctx.store.deleteVoice(name)
    return removed
  }
}

export const name = 'voices'
export const inject = ['store']

export function apply(ctx: Context, config: Config) {
  ctx.plugin(VoiceService, config)
}
