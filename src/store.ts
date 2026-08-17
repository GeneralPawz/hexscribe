import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Transcript } from './asr.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    store: StoreService
  }
}

/**
 * Where an application's data belongs on this operating system.
 *
 * Not next to the code: a checkout is a thing you delete and re-clone, and the
 * transcripts are not. Windows has said `%LOCALAPPDATA%` since Vista, macOS
 * `~/Library/Application Support`, and everything else follows the XDG spec —
 * `$XDG_DATA_HOME` or `~/.local/share`. Local rather than roaming on Windows,
 * deliberately: audio blobs have no business being synced to a domain profile.
 */
export function defaultDataDirectory(platform = process.platform, env = process.env): string {
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hexscribe')
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'hexscribe')
  }
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'hexscribe')
}

export interface Run {
  id: string
  name: string
  /** `upload` came through the browser; `disk` was transcribed where it lay. */
  source: 'upload' | 'disk'
  /** For a disk run, the file itself — which is also how playback finds it. */
  path: string | null
  /**
   * The file the engine read, upload included.
   *
   * Kept so an interrupted run can be resumed: an upload's temporary copy is
   * deleted when a job *settles*, and a run that was interrupted never did, so
   * the file is usually still there.
   */
  source_path: string | null
  /**
   * `running` while it is happening, and left that way by a crash — which is
   * how an interrupted run is recognised at the next start.
   */
  status: 'running' | 'done' | 'failed' | 'interrupted'
  created: number
  finished: number
  wall_ms: number
  engine: string | null
  model: string | null
  language: string | null
  task: string
  diarize: number
  merge: number
  audio_seconds: number
  segments: number
  speakers: number
  rtf: number
  error: string | null
  /** Whether a compressed copy of the audio is held in the database. */
  has_audio: number
  audio_bytes: number
}

export interface StoreStats {
  runs: number
  transcripts: number
  audioClips: number
  audioBytes: number
  logs: number
  /** The database file itself, which is what a person means by "how big is it". */
  fileBytes: number
  path: string
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  id: number
  run_id: string | null
  level: LogLevel
  message: string
  created: number
}

/** Defaults a person set once and expects every later run to use. */
export interface Settings {
  language: string
  task: 'transcribe' | 'translate'
  model: string
  diarize: boolean
  merge: boolean
  notify: boolean
  /** Keep a compressed copy of uploaded audio, so a run stays playable. */
  storeAudio: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'de',
  task: 'transcribe',
  model: 'whisper-1',
  diarize: false,
  merge: true,
  notify: false,
  storeAudio: true,
}

export interface Config {
  path: string
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.string().description(
    'Database file. Defaults to the platform data directory (%LOCALAPPDATA%\\hexscribe on Windows).',
  ),
})

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'upload',
    path          TEXT,
    source_path   TEXT,
    status        TEXT NOT NULL,
    created       INTEGER NOT NULL,
    finished      INTEGER NOT NULL,
    wall_ms       INTEGER NOT NULL DEFAULT 0,
    engine        TEXT,
    model         TEXT,
    language      TEXT,
    task          TEXT NOT NULL DEFAULT 'transcribe',
    diarize       INTEGER NOT NULL DEFAULT 0,
    merge         INTEGER NOT NULL DEFAULT 0,
    audio_seconds REAL NOT NULL DEFAULT 0,
    segments      INTEGER NOT NULL DEFAULT 0,
    speakers      INTEGER NOT NULL DEFAULT 0,
    rtf           REAL NOT NULL DEFAULT 0,
    error         TEXT
  );
  CREATE INDEX IF NOT EXISTS runs_created ON runs (created DESC);

  -- Separate from runs so listing a hundred of them does not read a hundred
  -- transcripts: the list needs a name and a duration, not 60 kB of text.
  CREATE TABLE IF NOT EXISTS transcripts (
    run_id TEXT PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
    json   TEXT NOT NULL
  );

  -- Utterances as they are decoded, before there is a transcript to speak of.
  -- A run interrupted at forty minutes has forty minutes of these, which is the
  -- difference between resuming and starting again.
  CREATE TABLE IF NOT EXISTS run_segments (
    run_id  TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    idx     INTEGER NOT NULL,
    start   REAL NOT NULL,
    end     REAL NOT NULL,
    text    TEXT NOT NULL,
    speaker TEXT,
    PRIMARY KEY (run_id, idx)
  );

  CREATE TABLE IF NOT EXISTS audio (
    run_id   TEXT PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
    mime     TEXT NOT NULL,
    bytes    BLOB NOT NULL,
    original INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  TEXT,
    level   TEXT NOT NULL,
    message TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS logs_created ON logs (created DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

/**
 * Everything worth keeping after a run finishes.
 *
 * Transcribing an hour of audio costs four minutes of NPU; throwing the result
 * away when the tab closes makes the user pay it again. So a run is recorded:
 * the transcript, how long it took and how fast, what was asked for, whatever
 * went wrong, and — optionally — a compressed copy of the audio so the result
 * stays playable.
 *
 * SQLite through `node:sqlite`, which ships with Node and needs no native
 * build. That matters more here than usual: this is a `win_arm64` machine,
 * where a package needing a compiler is a package that does not install.
 *
 * Everything is one file. Backing it up is copying it, and the danger zone in
 * Settings can delete it, because a tool that records what people said had
 * better make it obvious how to unrecord it.
 */
export class StoreService extends Service {
  private db: DatabaseSync
  readonly path: string

  constructor(
    ctx: Context,
    public config: Config,
  ) {
    super(ctx, 'store')
    this.path = config.path
      ? resolve(process.cwd(), config.path)
      : join(defaultDataDirectory(), 'hexscribe.db')
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.migrate()

    // A run still marked `running` at startup is one the last process did not
    // live to finish. Nothing else can tell the difference, because a crash
    // leaves no record of itself -- only this gap between what the row says and
    // the fact that nothing is running.
    const orphaned = this.db.prepare("UPDATE runs SET status = 'interrupted' WHERE status = 'running'").run()
    if (orphaned.changes) {
      this.log('warn', `${orphaned.changes} run(s) were interrupted by a restart and can be resumed`)
    }

    ctx.effect(() => () => this.db.close(), 'store-handle')
  }

  /**
   * Add columns a newer version expects to a table an older one created.
   *
   * `CREATE TABLE IF NOT EXISTS` does exactly nothing to a table that already
   * exists, including one missing half the columns — so a database written by
   * yesterday's build keeps yesterday's shape and every insert against it fails.
   * That failure is quiet in the worst way: the writes were wrapped in a
   * try/catch that logged somewhere nobody was reading, so runs simply stopped
   * being recorded and nothing said so.
   *
   * Additive only, and that is the whole policy: SQLite can add a nullable
   * column to a populated table instantly, and anything more than that is a
   * migration that deserves to be written down rather than inferred here.
   */
  private migrate() {
    const wanted: Record<string, Record<string, string>> = {
      runs: { source_path: 'TEXT' },
    }
    for (const [table, columns] of Object.entries(wanted)) {
      const present = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      )
      for (const [column, type] of Object.entries(columns)) {
        if (present.has(column)) continue
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
        this.log('info', `added column ${table}.${column}`)
      }
    }
  }

  // --- runs ------------------------------------------------------------

  saveRun(run: Omit<Run, 'has_audio' | 'audio_bytes'>, transcript?: Transcript) {
    this.db
      .prepare(
        // An upsert, emphatically not `INSERT OR REPLACE`. That is a delete
        // followed by an insert, so re-opening an existing run fired the
        // `ON DELETE CASCADE` on run_segments and destroyed everything decoded
        // before the interruption -- at the exact moment somebody asked to
        // continue it. `ON CONFLICT DO UPDATE` leaves the row in place.
        `INSERT INTO runs
         (id, name, source, path, source_path, status, created, finished, wall_ms, engine, model,
          language, task, diarize, merge, audio_seconds, segments, speakers, rtf, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, source = excluded.source, path = excluded.path,
           source_path = excluded.source_path, status = excluded.status,
           finished = excluded.finished, wall_ms = excluded.wall_ms, engine = excluded.engine,
           model = excluded.model, language = excluded.language, task = excluded.task,
           diarize = excluded.diarize, merge = excluded.merge,
           audio_seconds = excluded.audio_seconds, segments = excluded.segments,
           speakers = excluded.speakers, rtf = excluded.rtf, error = excluded.error`,
      )
      .run(
        run.id,
        run.name,
        run.source,
        run.path,
        run.source_path,
        run.status,
        run.created,
        run.finished,
        run.wall_ms,
        run.engine,
        run.model,
        run.language,
        run.task,
        run.diarize,
        run.merge,
        run.audio_seconds,
        run.segments,
        run.speakers,
        run.rtf,
        run.error,
      )

    if (transcript) {
      this.db
        .prepare('INSERT OR REPLACE INTO transcripts (run_id, json) VALUES (?, ?)')
        .run(run.id, JSON.stringify(transcript))
    }
  }

  listRuns(limit = 200): Run[] {
    return this.db
      .prepare(
        `SELECT r.*,
                CASE WHEN a.run_id IS NULL THEN 0 ELSE 1 END AS has_audio,
                COALESCE(LENGTH(a.bytes), 0) AS audio_bytes
         FROM runs r LEFT JOIN audio a ON a.run_id = r.id
         ORDER BY r.created DESC LIMIT ?`,
      )
      .all(limit) as unknown as Run[]
  }

  getRun(id: string): (Run & { transcript?: Transcript }) | undefined {
    const row = this.db
      .prepare(
        `SELECT r.*,
                CASE WHEN a.run_id IS NULL THEN 0 ELSE 1 END AS has_audio,
                COALESCE(LENGTH(a.bytes), 0) AS audio_bytes
         FROM runs r LEFT JOIN audio a ON a.run_id = r.id
         WHERE r.id = ?`,
      )
      .get(id) as unknown as Run | undefined
    if (!row) return undefined

    const stored = this.db.prepare('SELECT json FROM transcripts WHERE run_id = ?').get(id) as
      | { json: string }
      | undefined
    if (stored) return { ...row, transcript: JSON.parse(stored.json) as Transcript }

    // No finished transcript: a run that is still going, or one that was
    // interrupted. Either way the utterances decoded so far are worth handing
    // over -- that is the whole reason they were written down one at a time.
    const partial = this.runSegments(id)
    if (!partial.length) return { ...row, transcript: undefined }
    return {
      ...row,
      transcript: {
        engine: row.engine ?? 'unknown',
        model: row.model ?? 'unknown',
        ...(row.language ? { language: row.language } : {}),
        segments: partial,
        text: partial.map((segment) => segment.text).join(' '),
        timing: { audio_seconds: row.audio_seconds, total_ms: row.wall_ms, rtf: row.rtf },
      },
    }
  }

  deleteRun(id: string): boolean {
    // The audio and transcript go with it: they are of no use to anything else,
    // and leaving them would make "delete this run" a lie.
    const result = this.db.prepare('DELETE FROM runs WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM transcripts WHERE run_id = ?').run(id)
    this.db.prepare('DELETE FROM run_segments WHERE run_id = ?').run(id)
    this.db.prepare('DELETE FROM audio WHERE run_id = ?').run(id)
    return result.changes > 0
  }

  /** Repoint a run at a file on disk, usually after dropping its stored audio. */
  setRunSource(id: string, source: 'upload' | 'disk', path: string | null): boolean {
    const result = this.db.prepare('UPDATE runs SET source = ?, path = ? WHERE id = ?').run(source, path, id)
    return result.changes > 0
  }

  // --- utterances, as they arrive ---------------------------------------

  /**
   * Record one utterance the moment it is decoded.
   *
   * `INSERT OR REPLACE` rather than plain insert: resuming re-decodes from the
   * last utterance boundary, so the first one or two of a resumed run can
   * overlap what is already stored. Replacing keeps the newer reading rather
   * than failing on the key.
   */
  appendSegment(runId: string, segment: { index: number; start: number; end: number; text: string; speaker?: string }) {
    this.db
      .prepare('INSERT OR REPLACE INTO run_segments (run_id, idx, start, end, text, speaker) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, segment.index, segment.start, segment.end, segment.text, segment.speaker ?? null)
  }

  /** What has been decoded so far, in order. */
  runSegments(runId: string): Array<{ index: number; start: number; end: number; text: string; speaker?: string }> {
    const rows = this.db
      .prepare('SELECT idx, start, end, text, speaker FROM run_segments WHERE run_id = ? ORDER BY idx')
      .all(runId) as unknown as Array<{ idx: number; start: number; end: number; text: string; speaker: string | null }>
    return rows.map((row) => ({
      index: row.idx,
      start: row.start,
      end: row.end,
      text: row.text,
      ...(row.speaker ? { speaker: row.speaker } : {}),
    }))
  }

  /** Dropped once a finished transcript supersedes them. */
  clearRunSegments(runId: string) {
    this.db.prepare('DELETE FROM run_segments WHERE run_id = ?').run(runId)
  }

  // --- audio -----------------------------------------------------------

  saveAudio(runId: string, mime: string, bytes: Uint8Array, originalBytes: number) {
    this.db
      .prepare('INSERT OR REPLACE INTO audio (run_id, mime, bytes, original) VALUES (?, ?, ?, ?)')
      .run(runId, mime, bytes, originalBytes)
  }

  getAudio(runId: string): { mime: string; bytes: Uint8Array } | undefined {
    const row = this.db.prepare('SELECT mime, bytes FROM audio WHERE run_id = ?').get(runId) as
      | { mime: string; bytes: Uint8Array }
      | undefined
    return row
  }

  deleteAudio(runId: string): boolean {
    return this.db.prepare('DELETE FROM audio WHERE run_id = ?').run(runId).changes > 0
  }

  /** The danger zone's smaller button: forget the recordings, keep the words. */
  clearAudio(): number {
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM audio').get() as { count: number }
    this.db.exec('DELETE FROM audio')
    this.vacuum()
    return count
  }

  // --- logs ------------------------------------------------------------

  log(level: LogLevel, message: string, runId: string | null = null) {
    this.db
      .prepare('INSERT INTO logs (run_id, level, message, created) VALUES (?, ?, ?, ?)')
      .run(runId, level, message.slice(0, 4000), Date.now())
  }

  recentLogs(limit = 100, runId?: string): LogEntry[] {
    const sql = runId
      ? 'SELECT * FROM logs WHERE run_id = ? ORDER BY created DESC, id DESC LIMIT ?'
      : 'SELECT * FROM logs ORDER BY created DESC, id DESC LIMIT ?'
    const statement = this.db.prepare(sql)
    return (runId ? statement.all(runId, limit) : statement.all(limit)) as unknown as LogEntry[]
  }

  // --- settings --------------------------------------------------------

  settings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as unknown as Array<{
      key: string
      value: string
    }>
    const stored: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        stored[row.key] = JSON.parse(row.value)
      } catch {
        // A value written by hand and malformed should not lose every setting.
      }
    }
    return { ...DEFAULT_SETTINGS, ...stored } as Settings
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const statement = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue // ignore anything we do not own
      statement.run(key, JSON.stringify(value))
    }
    return this.settings()
  }

  // --- housekeeping ----------------------------------------------------

  stats(): StoreStats {
    const one = (sql: string) => (this.db.prepare(sql).get() as { value: number }).value
    let fileBytes = 0
    try {
      // WAL means the main file lags; the -wal alongside it is part of the size
      // a person is asking about.
      fileBytes = statSync(this.path).size
      try {
        fileBytes += statSync(`${this.path}-wal`).size
      } catch {
        // No WAL file yet.
      }
    } catch {
      // The file is created on open, so this only fails if it was removed.
    }
    return {
      runs: one('SELECT COUNT(*) AS value FROM runs'),
      transcripts: one('SELECT COUNT(*) AS value FROM transcripts'),
      audioClips: one('SELECT COUNT(*) AS value FROM audio'),
      audioBytes: one('SELECT COALESCE(SUM(LENGTH(bytes)), 0) AS value FROM audio'),
      logs: one('SELECT COUNT(*) AS value FROM logs'),
      fileBytes,
      path: this.path,
    }
  }

  /** Reclaim the space a delete freed, so the reported size is the real one. */
  vacuum() {
    try {
      this.db.exec('VACUUM')
    } catch {
      // VACUUM cannot run inside a transaction; the size is stale, not wrong.
    }
  }

  /** The danger zone's larger button. Everything, including the settings. */
  reset() {
    this.db.exec(
      'DELETE FROM audio; DELETE FROM run_segments; DELETE FROM transcripts; ' +
        'DELETE FROM runs; DELETE FROM logs; DELETE FROM settings;',
    )
    this.vacuum()
  }
}

export const name = 'store'

export function apply(ctx: Context, config: Config) {
  ctx.plugin(StoreService, config)
}
