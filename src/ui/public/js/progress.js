/**
 * How far along a transcription is, without the server telling us.
 *
 * The API answers once, at the end, so there is no true progress to report. But
 * the two things that decide how long it takes are known before it starts: how
 * much audio there is, and how fast this machine transcribes. So the estimate is
 * elapsed time against a predicted duration, and the prediction improves itself
 * — every finished run records its real-time factor, and the next one uses it.
 *
 * The curve is asymptotic on purpose. A linear estimate that reaches the end
 * early has to sit at "done" while the work continues, which is a lie the user
 * can see; this one slows as it approaches and never claims completion. Only the
 * response sets 1.
 */

const STORE_KEY = 'hexscribe:rtf'

/** Fallbacks until this browser has seen a run: measured ~0.06-0.10 on an NPU. */
const DEFAULT_RTF = 0.09
/**
 * What asking for speakers adds.
 *
 * It used to dominate — the pyannote pass cost ~4.5x the transcription, all of
 * it on the CPU. Clustering the utterances instead costs one short embedding per
 * utterance and nothing else: measured 2.55s -> 3.20s and 1.83s -> 2.58s on the
 * two test recordings, so a third again rather than several times over.
 */
const DIARIZE_FACTOR = 1.35

export function readRtf(storage = globalThis.localStorage) {
  const stored = Number(storage?.getItem(STORE_KEY))
  return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_RTF
}

export function recordRtf(audioSeconds, wallSeconds, storage = globalThis.localStorage) {
  if (!(audioSeconds > 0) || !(wallSeconds > 0)) return
  const measured = wallSeconds / audioSeconds
  // Average with what we knew, so one odd run does not swing the next estimate.
  const blended = (readRtf(storage) + measured) / 2
  storage?.setItem(STORE_KEY, String(blended))
}

/** @returns predicted wall-clock seconds; a floor keeps short clips from finishing "instantly". */
export function estimateSeconds(audioSeconds, { diarize = false, rtf = readRtf() } = {}) {
  const audio = audioSeconds > 0 ? audioSeconds : 30
  return Math.max(1.5, audio * rtf * (diarize ? DIARIZE_FACTOR : 1))
}

/**
 * @returns 0..0.95 — approaches but never reaches the end, whatever happens.
 */
export function progressAt(elapsedSeconds, estimatedSeconds) {
  if (!(estimatedSeconds > 0)) return 0
  return 0.95 * (1 - Math.exp((-1.6 * elapsedSeconds) / estimatedSeconds))
}
