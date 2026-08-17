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
export async function transcribe({ file, model, language, task, diarize, merge, background, signal }) {
  const form = new FormData()
  form.append('file', file)
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

export async function getJob(id) {
  const response = await fetch(`/v1/jobs?id=${encodeURIComponent(id)}`)
  // Gone is a real answer, not an error: a finished job is dropped eventually,
  // and a page reattaching to one from yesterday needs to hear that plainly.
  if (response.status === 404) return null
  return (await unwrap(response)).json()
}

export async function forgetJob(id) {
  return postJson('/v1/jobs/forget', { id })
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
