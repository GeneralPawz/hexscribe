/**
 * The only module that knows the server's URLs.
 *
 * Errors arrive as OpenAI envelopes (`{ error: { message, code } }`); they are
 * unwrapped here so callers can just catch an Error with a readable message.
 */

async function unwrap(response) {
  if (response.ok) return response
  let message = `${response.status} ${response.statusText}`
  try {
    const body = await response.json()
    if (body?.error?.message) message = body.error.message
  } catch {
    // Not JSON: keep the status line.
  }
  throw new Error(message)
}

export async function getHealth() {
  return (await unwrap(await fetch('/health'))).json()
}

export async function getModels() {
  const body = await (await unwrap(await fetch('/v1/models'))).json()
  return body.data.map((model) => model.id)
}

/**
 * Transcribe a file.
 *
 * `verbose_json` is requested unconditionally: it is the only format carrying
 * segment times, and every other rendering is derived from it without asking
 * the NPU to do the work twice.
 */
export async function transcribe({ file, path, model, language, task, diarize, merge, background, signal }) {
  const form = new FormData()
  // A path instead of the bytes: the file never moves, which for an hour-long
  // interview is the difference between 189 MB and 557 bytes on the wire.
  if (path) form.append('path', path)
  else form.append('file', file)
  form.append('model', model)
  form.append('response_format', 'verbose_json')
  if (language) form.append('language', language)
  if (diarize) form.append('diarize', 'true')
  // Always stated, either way: absent would mean "whatever the server prefers",
  // and the checkbox is the user saying which they want.
  form.append('merge', merge ? 'true' : 'false')
  // A receipt instead of a transcript: the run outlives this request.
  if (background) form.append('background', 'true')

  const endpoint = task === 'translate' ? '/v1/audio/translations' : '/v1/audio/transcriptions'
  return (await unwrap(await fetch(endpoint, { method: 'POST', body: form, signal }))).json()
}

// --- background jobs ---------------------------------------------------

/**
 * Is this server able to run work in the background?
 *
 * Asked once, rather than assumed: `jobs.ts` is a plugin like any other and a
 * composition without it answers 404 here. The page then transcribes the way it
 * always did instead of polling a job that will never exist.
 */
export async function hasJobs() {
  try {
    return (await fetch('/v1/jobs')).ok
  } catch {
    return false
  }
}

/**
 * @param from how many utterances the caller already has, so a running job
 *   sends only what is new. Watching an hour-long run otherwise re-sends the
 *   whole growing transcript once a second.
 */
export async function getJob(id, from = 0) {
  const response = await fetch(`/v1/jobs?id=${encodeURIComponent(id)}&from=${from}`)
  // Gone is a real answer, not an error: a finished job is dropped eventually,
  // and a page reattaching to one from yesterday needs to hear that plainly.
  if (response.status === 404) return null
  return (await unwrap(response)).json()
}

export async function forgetJob(id) {
  return postJson('/v1/jobs/forget', { id })
}

// --- history, settings, files ------------------------------------------

export async function getRuns() {
  return (await (await unwrap(await fetch('/v1/runs'))).json()).runs
}

export async function getRun(id) {
  const response = await fetch(`/v1/runs?id=${encodeURIComponent(id)}`)
  if (response.status === 404) return null
  return (await unwrap(response)).json()
}

/** Continue an interrupted run from the last utterance it managed. */
export async function resumeRun(id) {
  return postJson('/v1/runs/resume', { id })
}

/** Call a run something else. The recording it was made from is untouched. */
export async function renameRun(id, name) {
  return postJson('/v1/runs/rename', { id, name })
}

export async function deleteRun(id) {
  return postJson('/v1/runs/delete', { id })
}

/** Drop a run's stored audio, optionally pointing it at a file on disk. */
export async function detachAudio(id, path) {
  return postJson('/v1/runs/audio/detach', { id, ...(path ? { path } : {}) })
}

// --- what a person added by hand ---------------------------------------
//
// Every one of these answers with the whole collection it changed, so the page
// re-renders from what the server now holds rather than from what it hoped the
// server would do. They are small -- a heavily marked-up hour is a few kilobytes
// -- and being right matters more here than one saved round trip: these are the
// only things in the database somebody typed.

export async function getAnnotations(runId) {
  return (await unwrap(await fetch(`/v1/annotations?run=${encodeURIComponent(runId)}`))).json()
}

export async function saveSection(runId, start, title) {
  return postJson('/v1/sections', { runId, start, title })
}

export async function deleteSection(runId, start) {
  return postJson('/v1/sections/delete', { runId, start })
}

/** An empty body clears the comment; that is how one is removed. */
export async function saveNote(runId, start, body) {
  return postJson('/v1/notes', { runId, start, body })
}

/** Carry annotations across when an edit joined two utterances. */
export async function moveAnnotations(runId, moves) {
  return postJson('/v1/annotations/move', { runId, moves })
}

export async function getTags() {
  return (await unwrap(await fetch('/v1/tags'))).json()
}

export async function tagUtterance(runId, start, tag, on = true) {
  return postJson('/v1/tags', { runId, start, tag, on })
}

export async function renameTag(from, to) {
  return postJson('/v1/tags/rename', { from, to })
}

export async function deleteTag(name) {
  return postJson('/v1/tags/delete', { name })
}

export async function getSettings() {
  return (await unwrap(await fetch('/v1/settings'))).json()
}

export async function saveSettings(patch) {
  return postJson('/v1/settings', patch)
}

export async function clearStoredAudio() {
  return postJson('/v1/store/clear-audio', {})
}

export async function resetStore() {
  // The server insists on the words, so that a stray POST cannot do this.
  return postJson('/v1/store/reset', { confirm: 'delete everything' })
}

/**
 * Browse this machine for a recording.
 *
 * Returns null when the server will not do it — bound to a real interface with
 * no api key, the plugin refuses to load, and offering a browse button that
 * 404s would be worse than not offering one.
 */
export async function listFiles(path) {
  const response = await fetch(`/v1/files${path ? `?path=${encodeURIComponent(path)}` : ''}`)
  if (response.status === 404 && !path) return null
  return (await unwrap(response)).json()
}

export async function hasLocalFiles() {
  try {
    return (await fetch('/v1/files')).ok
  } catch {
    return false
  }
}

// --- the voice library -------------------------------------------------

const postJson = async (url, body) =>
  (
    await unwrap(
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  ).json()

export async function getVoices() {
  return (await (await unwrap(await fetch('/v1/voices'))).json()).voices
}

/** Name a voice, or teach a name what else the same person sounds like. */
export async function enrollVoice({ name, embedding, seconds }) {
  return postJson('/v1/voices', { name, embedding, seconds })
}

/**
 * Fold hand-assigned utterances into a voice already in the library.
 *
 * The server embeds the ranges from the run's own audio, so nothing but the
 * times has to travel.
 */
export async function learnVoice({ name, runId, ranges }) {
  return postJson('/v1/voices/learn', { name, runId, ranges })
}

export async function forgetVoice(name) {
  return postJson('/v1/voices/forget', { name })
}

/** Re-render a transcript we already have. Costs nothing on the NPU. */
export async function formatTranscript(transcript, to) {
  const response = await unwrap(
    await fetch(`/ui/format?to=${encodeURIComponent(to)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(transcript),
    }),
  )
  return response.text()
}
