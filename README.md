# hexscribe

Local speech-to-text that runs on the **Qualcomm Hexagon NPU**, composed as
[Cordis](https://github.com/cordiverse/cordis) plugins.

Two goals, deliberately held together:

1. **Useful.** Transcribe audio on a Snapdragon X laptop, offline, at ~20× real
   time, without touching CPU-bound Whisper or sending audio anywhere.
2. **A test of a design philosophy.** Cordis says an application should be a
   *composition* of plugins that name capabilities rather than implementations,
   with every registration reversible. This repo puts that claim against real
   constraints: a subprocess, a quantized model, streaming results, and a
   one-shot CLI. `npm test` checks the claims rather than restating them.

## Status

Working end to end: `audio file → NPU → text/SRT/JSON`. Developer-grade; the
surface is a CLI. See [Roadmap](#roadmap).

## Requirements

- **Windows on ARM with a Hexagon NPU** (Snapdragon X Elite / X Plus — HTP v73).
  The model asset is a precompiled QNN context binary for that target.
- **ARM64 Python 3.11/3.12.** An x64 interpreter under Prism emulation cannot
  load the QNN DLLs. `uv` handles this if pointed at an ARM64 interpreter.
- **Node.js ≥ 22.**

## Quickstart

```powershell
.\scripts\fetch-models.ps1          # ~350 MB: QNN graphs + tokenizer
cd py; uv sync; cd ..               # ARM64 venv for the worker
npm install

.\hexscribe.ps1 --doctor            # is the NPU actually there?
.\hexscribe.ps1 recording.m4a --lang de
.\hexscribe.ps1 recording.m4a --format srt --out out\recording.srt
npm test                            # composition guarantees
```

Options: `--lang`, `--task transcribe|translate`, `--format text|srt|vtt|json`,
`--engine`, `--out`, `--no-timestamps`, `--diarize`, `--quiet`, `--doctor`.

```powershell
.\hexscribe.ps1 gespraech.ogg --lang de --diarize --format srt
# [SPEAKER_00] Ja, ich verstehe das ja auch...
# [SPEAKER_02] Wir haben Geburtstag am 20.06. zu feiern, zu zweit.
```

### As a local server

```powershell
.\hexscribe.ps1 serve --port 9000        # or: npm run serve
```

Then open **http://localhost:9000** — drop a file, pick a language, get a
timestamped transcript with copy and configurable `.srt` / `.vtt` / `.txt` /
`.json` export.
**Click any timestamp to hear that moment**: the file you dropped is played from
an object URL, so nothing is uploaded twice and nothing is cached on the server,
and the utterance being spoken is highlighted as it plays. A browser cannot
decode everything FFmpeg can, so when playback fails the timestamps go back to
plain text rather than pretending to be buttons that do nothing.
The page is plain ES modules served by the `ui` plugin; there is no build step
and no bundler. Its download panel posts the transcript back to `/ui/format`
rather than re-running the model or reimplementing SRT in browser JavaScript.

The same server is an OpenAI-compatible API, so existing clients work by
changing one URL:

```js
const client = new OpenAI({ baseURL: 'http://127.0.0.1:9000/v1', apiKey: 'unused-locally' })
await client.audio.transcriptions.create({
  file: createReadStream('recording.m4a'),
  model: 'whisper-1',
  language: 'de',
  response_format: 'verbose_json',
})
```

| | |
|---|---|
| `POST /v1/audio/transcriptions` | `file`, `model`, `language`, `response_format`, `timestamp_granularities[]`, `diarize`, `background` |
| `POST /v1/audio/translations` | same, into English |
| `GET /v1/models` | `whisper-1` plus every loaded engine, by name |
| `GET /health` | liveness, loaded engines, NPU status |
| `GET /v1/runs` | recorded runs; `?id=` for one, with its transcript and log |
| `GET /v1/runs/audio?id=` | the stored recording for a run |
| `POST /v1/runs/{delete,audio/detach}` | forget a run, or its audio |
| `GET /v1/files?path=` | browse this machine for a recording (loopback only) |
| `GET /v1/files/audio?path=` | stream one, with range requests |
| `GET,POST /v1/settings` | global defaults and database stats |
| `POST /v1/store/{clear-audio,reset}` | the danger zone |
| `GET /v1/jobs` | background runs; `?id=` for one, with its transcript when done |
| `POST /v1/jobs/forget` | drop a finished job early |
| `GET /v1/voices` | the named voices this machine knows |
| `POST /v1/voices` | name a voice, from a transcript's `voices` entry |
| `POST /v1/voices/{rename,forget}` | correct a name, or forget a person |
| `GET /` | the browser UI (from the `ui` plugin; remove it and this 404s) |
| `POST /ui/format?to=srt` | re-render a transcript the caller already has |

`response_format` accepts `json` (default), `verbose_json`, `text`, `srt`, `vtt`.
`model: "whisper-1"` means "the configured default engine", so unmodified
clients work; passing an engine name instead (`model: "qnn"`) selects it
directly. Verified against the official `openai` Node SDK, chunked upload and
error mapping included.

Binds loopback and runs unauthenticated by default. `--api-key KEY` requires
`Authorization: Bearer KEY`; set one before `--host 0.0.0.0`.

Python-side tests (engine, decoding rules, mel filterbank) run separately:
`cd py; .\.venv\Scripts\python -m pytest tests -q`. The NPU-dependent ones skip
themselves when the hardware or the model assets are missing.

`scripts/ui-check.mjs` drives the real page over the Chrome DevTools Protocol:
pick a file, transcribe, click a timestamp, read back what happened, screenshot
it. It is not part of `npm test` (it wants the NPU, Chrome, and a recording), but
it is what verifies the browser-only behaviour the node suite cannot reach:

```powershell
.\hexscribe.ps1 serve --port 9000
node scripts/ui-check.mjs http://127.0.0.1:9000/ test\fixtures\One_Speaker_de.wav out\ui.png
$env:HEXSCRIBE_SCHEME='light'   # the field is drawn differently in each theme
```

Some tests want a real recording, because synthetic tones do not exercise
resampling, a genuine mel spectrum, or a decode loop that terminates on speech.
Those recordings are **private**: `test/fixtures/` is where they live on a
machine that has them, **every audio extension is gitignored**, and a fresh clone
finds the directory empty and skips those tests. Point `HEXSCRIBE_TEST_AUDIO` at
any local file to use your own. They assert only structure (counts, ordering,
monotonic times) and never inspect or print what was said, so a failure cannot
leak the contents into a log.

The diarization numbers in this README come from two of them — one German
speaker, and three English voices with an oracle transcript beside it naming who
says what (`*_oracle.txt`, which is text and *is* committed).

> Use `.\hexscribe.ps1`, not `npm start -- <args>`, in PowerShell: the npm shim
> splats through `$args` and drops the `--`, so options never reach the app.
> From bash or cmd, `npm start -- <args>` is fine.

## Measured

Snapdragon X Plus X1P64100, `whisper-small` w8a16, 190.9 s of German
conversation, via the full CLI pipeline:

| | |
|---|---|
| wall clock | **12.0 s** (RTF **0.056**, ~18× real time) |
| encoder | ~363 ms per window (8 windows) |
| decoder | ~8.8 ms per token (779 tokens) |
| model load | ~1.0 s (both context binaries) |
| output | 28 timestamped utterances |
| memory | model assets 343 MB on disk |

Timestamped decoding costs ~15% over fixed 30 s windows (10.5 s → 12.0 s): the
seek overlaps windows slightly and the utterance boundaries cost extra tokens.
`--no-timestamps` buys that back.

No CPU baseline is measured yet on this machine — the numbers above are NPU
timings, not a speedup claim. (`ctranslate2` has no `win_arm64` wheels, so a
fair local baseline needs its own work.)

### Where the time goes

Profiled per decode step (`spikes/04_decode_bench.py`, 200 steps):

| | ms/step | share |
|---|---|---|
| ORT `Run` on the QNN EP | 7.66 | **96.7%** |
| sampler (dequantize + timestamp rules) | 0.20 | 2.5% |
| rebind 48 KV tensors | 0.05 | 0.6% |
| ids / mask / position updates | 0.01 | 0.2% |

That number is the ceiling on anything fixable from outside the graph. See
[IO binding](#io-binding-what-it-actually-bought) below.

## Architecture

```
cordis.yml ── the application, as configuration
   │
   ├── asr.ts             service `asr`: engine registry + waterfalls + events
   ├── worker-python.ts   service `worker`: owns the Python process (an effect)
   ├── engine-qnn.ts      registers engine `qnn`  ──inject──> asr, worker
   ├── engine-remote.ts   registers engine `remote` (OpenAI-compatible HTTP)
   ├── diarize.ts             service `diarize`: who spoke (CPU, opt-in)
   ├── diarize-utterances.ts  registers engine `utterances` (default)
   ├── diarize-sherpa.ts      registers engine `sherpa` ──inject──> diarize, worker
   ├── speakers.ts        listens on `transcript/finalize`, attaches speakers
   ├── store.ts           service `store`: the SQLite database
   ├── store-http.ts      history, settings, danger zone ──inject──> serve, store
   ├── history.ts         records finished runs ──inject──> jobs, store
   ├── audio-store.ts     keeps a small Opus copy ──inject──> jobs, store, worker
   ├── local-files.ts     service `localFiles`: reading audio where it lives
   ├── jobs.ts            service `jobs`: runs that outlive their request
   ├── jobs-http.ts       those over HTTP ──inject──> serve, jobs
   ├── voices.ts          service `voices`: names, and the prints that find them
   ├── voices-http.ts     the library over HTTP ──inject──> serve, voices
   ├── postproc-glossary.ts   listens on `transcript/finalize`
   ├── cli.ts             front-end: one shot     ──inject──> asr
   ├── serve/             front-end: HTTP         ──inject──> asr
   └── ui/                browser page            ──inject──> serve
                                  │
                                  │ JSON lines over stdio
                                  ▼
              py/hexscribe_worker/worker.py
                     audio (PyAV) → log-mel (numpy) → quantize u16
                     → ENCODER (NPU) → cross-KV u8
                     → DECODER (NPU) × N tokens → tokenizer
```

The two front-ends share everything below them and know nothing about each
other. `cordis.yml` gates them on one environment variable, because a CLI runs
once and unwinds the application while a server stays up — the same composition,
two lifetimes.

Inside `src/serve/`, one concern per file: `http.ts` adapts `node:http` to the
Fetch `Request`/`Response` pair (which is also what gives multipart parsing for
free, no `busboy`), `router.ts` matches, `auth.ts` checks bearer tokens,
`upload.ts` owns the temp file's whole life, `openai.ts` holds the shapes that
API defines, and `routes/*.ts` are handler factories taking their dependencies
as an argument. Generic renderers live one level up in `formats.ts`, shared with
the CLI, so "what an SRT looks like" has exactly one implementation.

### Utterance boundaries

Whisper cuts at decode-window edges, not at sentence ends, so a sentence that
straddles a window arrives as two utterances — "…bei dem Lehrstuhl" then
"Baubetrieb und Bauverfahren in Weimar". Both fixes are available:

- **By hand**, through direct manipulation rather than buttons on every line —
  a transcript is for reading first:
  - **Ctrl+click** rows to select a run. A toolbar appears between the player
    and the first utterance, carrying *Merge N*, *Speaker* and *Clear*; it exists
    only while something is selected, because it belongs to the selection rather
    than to the page. Only an unbroken run can merge — joining rows 1 and 4 would
    silently swallow 2 and 3 — so a broken selection reads *not adjacent* and the
    merge is disabled.
  - **Right-click** a row for its own menu: *Play from here*, *Split here*,
    *Edit text*, *Merge up*, *Merge down*. Labels only; an item that needs
    explaining is named wrong. Both *here*s are the caret position **under the
    pointer**, snapped to the nearest gap between words — split lands there, and
    playback starts there, so a timestamp starts an utterance and this starts a
    sentence in the middle of one. Right-clicking past the end of a short line
    means the row itself, because the final instant of an utterance is no use to
    anyone.
  - **Click a speaker chip** to open the panel for that *person* — who they are,
    and what to remember them as. Which speaker said a given utterance is a
    different question, and it lives in the row menu's *Change speaker* and the
    toolbar's *Speaker* (which applies to the whole selection, so relabelling a
    stretch of conversation is one action). Both list the speakers already in the
    transcript, plus *New speaker* (the first free `SPEAKER_NN`) and *No
    speaker*, which removes the label rather than inventing an unknown one.
  - **Double-click the text** — or *Edit text* in the menu — opens a plain
    textarea on that row (Enter commits, Escape cancels) for fixing what the
    model misheard. Double-click is what a person tries first on a wrong word.
    Corrected rows are marked, so a correction is never mistaken for what the
    audio actually says.
  - **Escape** gives the selection back. The menu and the editor consume the key
    while they are open, so one press dismisses exactly one thing, innermost
    outwards: the menu, then the selection.
  - Boundary times are interpolated by character position: wrong in detail,
    close enough to click on, and the only honest option without word-level
    timings. Everything is undoable and flows into copy, the downloads and the
    playback highlight.

  Shift+right-click still gets the browser's own menu, rows are focusable, and
  the keyboard menu key opens the row menu like right-click does.
- **Automatically**, via the `postproc-merge` plugin (checkbox in the UI,
  `merge=false` on the API, `--no-merge` on the CLI). Punctuation is the signal:
  the model punctuates what it hears, so an utterance ending without a full stop
  was interrupted rather than finished. Speaker changes, long pauses, and
  runaway length are the guards.

Both call the same module, `ui/public/js/segments.js` — plain JavaScript so the
browser can be served it as-is and the Cordis plugin can import it, because a
merge done by hand and a merge done automatically must not be able to disagree.

**One measurement changed the design.** The gap tolerance started at 0.8 s and
did nothing for the reported case: the two halves were 14.16 s and 15.28 s apart
— a **1.12 s** hole that was never a pause. Whisper marks where speech stops and
the next window starts where the seek put it, so a boundary *inside* one sentence
routinely shows a second of "silence". The tolerance is 1.5 s because that is
what the artefact measures, not because it sounded right.

### The shell: a rail, a history, and settings

The application name lives in the left rail, not above the transcript — the main
pane is for the document, and a title bar repeating "hexscribe" over every one of
them was decoration. The rail is a column of icons that widens on hover or focus,
and it **overlays** rather than pushing the page, because a layout that reflows
whenever the pointer crosses it is a layout that fidgets.

It holds what is true across the app rather than about the thing on screen: a new
transcript, past runs, and settings pinned at the bottom with the NPU badge.
More will follow; that is what the rail is for.

**Jobs** lists finished runs from the database, newest first, each with its
duration, utterance count and a ♪ when the audio was kept. Clicking one brings it
back into the main pane — the same rendering as a fresh run, deliberately, so
there is one transcript view and not two — and opens the right-hand aside with
what the run cost: when, how long, how fast, which engine, and its log. That is
also where a recording is disposed of, because "this one is 10 MB and I have the
file on disk anyway" is a judgement about *that* run and not a global setting.

**Settings** is a modal, and a `<dialog>` rather than a div and a scrim: the
browser already knows how to trap focus, close on Escape and paint a backdrop.
It carries the defaults for new runs (they populate the form, so setting one
here changes what every run starts as), storage, and a danger zone.

### Everything worth keeping

Transcribing an hour costs four minutes of NPU. Throwing the result away when
the tab closes makes you pay it again, so every run is recorded: the transcript,
how long it took and how fast, what was asked for, what went wrong, and
optionally the audio.

One SQLite file, through **`node:sqlite`** — which ships with Node and needs no
native build. That matters more here than usual: this is a `win_arm64` machine,
where a package needing a compiler is a package that does not install.

It lives where the platform keeps application data — `%LOCALAPPDATA%\hexscribe`
on Windows, `~/Library/Application Support` on macOS, `$XDG_DATA_HOME` elsewhere
— and **not** next to the code, because a checkout is a thing you delete and
re-clone and the transcripts are not. Local rather than roaming on Windows,
deliberately: audio blobs have no business being synced to a domain profile.
Backing it up is copying one file.

The danger zone has two buttons because they are two different regrets:

| | |
|---|---|
| **Delete stored audio** | forgets the recordings, keeps every transcript. One click — the expensive part is untouched. |
| **Delete the whole database** | keeps nothing. Enabled only after typing *delete everything*, and the server refuses the request without the same words in the body. |

A tool that records what people said had better make it obvious how to unrecord
it.

### Reading audio where it already lives

Uploading a 180 MB interview to a server on the same laptop copies it for no
reason: through the browser's memory, over a socket to itself, into a temporary
file, and then deletes it. **Choose a file on this machine** transcribes it where
it lies. Measured on that interview:

| | uploaded | in place |
|---|---|---|
| sent to the server | 189 MB | **557 bytes** |
| before the job started | ~4 s | **0.12 s** |
| left to play back afterwards | nothing | the file itself |

The browser cannot help with this — a file input hands over a name and bytes and
deliberately never a path — so the server does the browsing and the picker is a
view of it. That is a filesystem API over HTTP, so it is fenced:

- **Loopback only, or an api key.** Bound to a real interface with neither, the
  plugin refuses to load and says which of the two to fix.
- **Media extensions only**, for both listing and streaming. It can find
  recordings; it cannot read `id_rsa`.
- **Read only.** No route there writes, moves or deletes anything.

Playback is ranged, so seeking inside an hour-long MP3 fetches the window it
needs rather than the file.

### Keeping the audio, small enough to keep

An uploaded recording is gone the moment the run finishes, which leaves a
transcript whose clickable timestamps have nothing to click into. So uploads are
re-encoded to 16 kHz mono Opus and stored beside the transcript. Measured: 33.8 s
becomes **96 kB** — about 23 kbps — so an hour-long interview is roughly 10 MB
against the 180 MB it arrived as. Keeping the original bytes was never an option
at that size, and at speech bitrates the difference is inaudible.

A run read from disk stores nothing: the file is already there and the run
remembers where. And from the run panel a stored recording can be dropped and the
run pointed at a file on disk instead — the two halves of one intent, for
somebody reclaiming space who still wants to hear it.

This all hangs on ordering: `job/settled` is emitted with `ctx.parallel` and
awaited **before** the upload is deleted. `emit` would have deleted the file out
from under the listener that wanted to keep it.

### Work that outlives the request

An hour of audio is minutes of NPU. Holding an HTTP connection open for that
means a caller with a connection it cannot use, no idea how far along it is, and
**no result at all if the tab closes**. So the work can be moved off the request:

```bash
curl -X POST http://127.0.0.1:9000/v1/audio/transcriptions   -F "file=@interview.mp3" -F "model=whisper-1" -F "background=true"
# {"id":"db72a0ac-…","status":"running","name":"interview.mp3"}   (202, in ~1 s)

curl "http://127.0.0.1:9000/v1/jobs?id=db72a0ac-…"
# {"status":"running","progress":{"seconds":2293.9,"duration":4723.2,
#  "fraction":0.486,"segments":382}}
```

Off unless asked for, because a stock OpenAI client expects a transcript in the
response and would be broken by a receipt. Measured on the 1.31 h interview: the
POST returned in **1 s**, progress tracked linearly, and the transcript was
waiting at 288 s.

**Progress is measured, not estimated.** The engine emits each utterance as it
decodes it, carrying the time it ended, and the audio's duration arrives before
any of it — so "34 minutes of 79" is a fact. Where an engine cannot report a
duration (one that posts the file to someone else's API never learns it), the
fraction is **absent rather than invented**; the seconds transcribed are still
true. The browser's own estimate is only shown until the first real number
arrives, then it stops: a prediction is what you show when you have nothing.

**The tab is no longer load-bearing.** The job id goes into `localStorage`, so a
reload — or a crash, or closing the window and coming back — finds the run again
and shows the transcript when it lands. `scripts/reattach-check.mjs` proves it by
discarding the page mid-transcription and asserting the reloaded one picks it up.

**Windows hears about it.** With *Notify me* ticked, progress and completion go
to the notification centre, updated under one tag so it holds one line per run
rather than a hundred, silent until the finish. Two honest limits: the tab must
still *exist* (backgrounded and minimised are fine; closed runs no code, and
fixing that needs a service worker), and the job outliving the page is what makes
that acceptable — the result is waiting either way.

Jobs live in memory and are swept after an hour. Persisting them would mean
persisting the audio too, and the uploads are deliberately temporary.

### Naming a voice, once

`SPEAKER_00` is an ordinal, not an identity: it means "whoever spoke first in
this file", so the same person is `SPEAKER_00` in one recording and `SPEAKER_02`
in the next. Diarization can say *these utterances are one person*; nothing in
the audio will ever say who. That comes from a human, once.

Click a speaker chip, type a name, save. The name is stored against the
speaker's **voice print** — the duration-weighted centroid of their utterance
embeddings — so the next recording of the same person is recognised without
being told again. Measured, by enrolling from one half of a recording and
transcribing the other half as a separate file:

| | |
|---|---|
| same person, different file | **0.12 – 0.49** |
| different people | **0.60** and up |
| threshold / required margin | 0.55 / 0.05 |

The narrator of the three-speaker fixture came back named at **0.095** in a file
they had never been named in, and the two people who were never enrolled — one in
the same recording, one in another language entirely — correctly stayed numbers.

That gap is real but not wide, so the rule has two conditions rather than one:
the nearest print must be close enough **and** clearly closer than the runner-up.
An ambiguous match returns nothing, because a confident wrong name is worse than
a number — it is indistinguishable from a real attribution once it is on screen.
For the same reason one stored voice cannot claim two speakers in one recording:
that would be certainly wrong for one of them, so the runner-up keeps its number.

Enrolling the same person again **improves** the print rather than replacing it,
weighted by how much speech is behind each side — a voice heard in two rooms is
described better by both than by whichever was most recent.

**Where it lives.** `voices.json`, next to the composition, and it is
gitignored. Speaker embeddings identify a specific person by their voice, which
makes this the most sensitive file the app writes — more so than a transcript,
because it is the thing that recognises someone in a recording they are not
expecting to be in. It never leaves the machine, the path is configuration, and
deleting the file forgets everyone. Remove `voices.ts` from `cordis.yml` and
speakers stay numbered; everything else is unchanged.

### One panel, many contents

The right-hand aside is hidden until something asks for it, and two unrelated
things ask: a speaker's identity, and the download options. It owns *being a
panel* — sliding in, closing on Escape, focus, the page yielding width so it
never covers the transcript it is talking about — and knows nothing about what it
is showing. Content modules (`panel-speaker.js`, `panel-download.js`) get an
empty element and return a disposer.

Non-modal on purpose: no scrim, and the transcript stays clickable. Everything
this panel does is *about* the transcript, so hiding it would be backwards.

Download used to be four buttons — `.srt .vtt .txt .json` — which said "here are
four formats" and nothing else. One button opening the panel is fewer things on
screen and more that can be asked for: format, whether to include speaker
labels, and what to call the file. Dropping the labels is done by removing a
field from the transcript before sending it, not by a second rendering mode, so
the server still renders SRT in exactly one place.

Escape dismisses exactly one thing, innermost outwards: the row menu, then the
panel, then the selection. Each layer consumes the key only if it was open.

### The field is the progress indicator

There is no progress bar. The WebGL field behind the drop zone carries the state
of the run — **speed** for "something is happening", **colour** for *which*
something — so one element tells the whole story and nothing animates while idle
except the thing that means *ready*:

| state | field | frame | label |
|---|---|---|---|
| waiting | slow drift, accent | dashed | "Drop audio here" |
| armed | calmer, accent | dashed | the file name |
| **hovered / dragged over** | **middle gear, same colour** | dashed | unchanged |
| working | fast, amber, **at once** | solid amber | "Transcribing… 4.2 s · about 45%" |
| finished | eases to green, slows | solid green | "done in 9.5 s" — and **holds** |

Hovering is not a state of its own: it keeps whatever colour the app is in and
only changes the tempo, because it is not news about the transcript. It is the
field saying *I can see you are about to give me something* — the one moment a
drop zone should look more awake than it did a second ago. It is suppressed while
the NPU is running, where the pace is reporting something and a pointer passing
over must not be able to change what it says.

Working is about **two and a half times** waiting, which is the ratio that reads
as *faster* without reading as *racing* — a different feeling, and the wrong one:
racing says something is wrong, not that something is happening.

Three named tones, not a 0→1 ramp: a colour halfway between "waiting" and "done"
is not something a person can read, so the honest progress number lives in the
label underneath, where it can say *about*. Working **snaps** — the run has
already started by the time the first frame lands, so a fade-in would spend its
first second still looking idle. Finished **holds**: the transcript below is
still the answer, and a field that drifted back to "ready" would say otherwise.
Dropping a new file is the only thing that makes the last result stale, so that
is what puts the field back to the beginning.

Brightness is nearly flat across all four states, which is deliberate. Energy
used to carry brightness with it, so the calm states were also the dim ones —
faint exactly when the page had something to say — and the light theme, which
boosts alpha by 1.55 to carry on white, clipped a brighter "working" state into
one solid stroke instead of a wash. The tempo does the talking; every state sits
around the alpha the idle field was tuned to in both themes.

The bar it replaced was worse than useless: `.progress { display: flex }`
silently beat the `hidden` attribute, so it sat there animating while the app was
idle, claiming work that was not happening. A global `[hidden] { display: none }`
now makes `show()` mean something.

`ui/public/js/shader.js` is ~45 lines of GLSL and one draw call per frame at
30 fps, no library and no build step. Four things it does deliberately, each
because the naive version showed a visible straight-line artefact:

- **Edges fade in the shader, not in a CSS mask.** The mask it started with had
  a horizontal radius of 125% of the box, putting the box's own left and right
  edges at 40% of that radius — fully opaque — so every band was chopped off
  mid-stroke at both ends.
- **The bands are Gaussian, `exp(-y*y*k)`, not `exp(-|y|*k)`.** An absolute
  value creases at the band centre, and the crease renders as a bright hairline
  running the full width of the frame.
- **The drift is a sum of incommensurate sines, not value noise.** Value noise
  needs a `sin`-based hash sampled on an axis-aligned lattice, and its sample
  point drifts with time; on a tile-based mobile GPU the hash loses precision as
  the coordinate grows and the lattice surfaces as horizontal and vertical seams.
- **The canvas gets its own compositor layer.** With `z-index: -1` it was
  rasterised as part of the label, so each animated frame invalidated the
  label's raster tiles and Chrome refreshed them independently — ~256 px
  rectangles with hard edges drifting through the field. `will-change: transform`
  makes it one uploaded texture; the label text takes `z-index: 1` instead. It is decoration by construction: no
WebGL, a driver that refuses the shader, or a lost context and the canvas removes
itself, leaving the plain CSS drop zone. It stops rendering when the tab is
hidden or the zone is scrolled off, and draws a single static frame under
`prefers-reduced-motion`. **Progress is estimated, and says so by construction.** The API answers once, at
the end, so there is no true progress to report; the estimate is elapsed time
against a prediction from the audio's duration and this machine's measured
real-time factor, which every finished run refines and stores. The curve is
asymptotic — it slows as it approaches and tops out at 0.95 — because an estimate
that reaches the end early has to sit at "done" while the work continues, which
is a lie the user can see. Only the response finishes it, and only then does the
field turn green.

Routes are a registry, not a fixed table: `ctx.serve.route()` attaches to the
*calling* plugin's fiber, so another plugin can add an endpoint and unloading it
takes the endpoint away — the same pattern `ctx.asr.register()` uses.

`src/ui/` is the first consumer of that registry, and deliberately owns nothing
but routes: it injects `serve` and registers exactly as a third-party plugin
would. `index.ts` enumerates `public/` once at load and gives each file its own
route, which keeps the router's exact-match simplicity *and* makes path
traversal impossible by construction — a request never contributes to a
filesystem path, it only looks up a table the server built. The page itself is
`index.html`, one stylesheet, and four ES modules (`api`, `dom`, `transcript`,
`main`), none over ~110 lines.

**Why a Python sidecar.** The QNN execution provider, its plugin-EP
registration, and the `win_arm64` wheels for audio decoding exist in Python
today; `onnxruntime-node` has no verified QNN path. The process boundary is not
a workaround though — it is where the NPU's constraints stay contained, and in
Cordis terms it is one plugin's effect: delete the `worker-python.ts` entry and
the process is gone.

**Why the model looks like that.** The asset is not a float ONNX export; it is
two fixed-shape QAIRT context binaries with quantized tensors:

- encoder: `input_features [1,80,3000] uint16` → 24 cross-attention KV tensors, `uint8`
- decoder: one token per call, 200-token window, `logits [1,51865,1,1] uint16`

Every scale and zero-point comes from the asset's `metadata.json` at runtime —
no quantization constant is hardcoded. Cross-KV never leaves the quantized
domain.

## Timestamps

Whisper can emit `<|0.00|>`-style tokens that bracket each utterance, which is
what turns the output from 30 s blocks into a real SRT. Three things were needed
to get them, and each was a separate discovery:

**1. Greedy argmax cannot produce them.** The model spreads its confidence
across 1501 timestamp tokens, so any single one loses to the best text token —
it emits `<|0.00|>` and then never another. OpenAI's decoder applies
`ApplyTimestampRules`; `whisper_qnn._next_token` reproduces it. The rule that
matters is the aggregate one: *if the summed probability of all timestamps beats
the best single text token, force a timestamp.* (The softmax normalizer cancels
on both sides, so only a 1501-wide logsumexp is computed, not a full log-softmax
over 51,865 classes — 0.2 ms/token.)

**2. A fixed 30 s stride cuts sentences in half.** Every window boundary landed
mid-utterance. The fix is Whisper's sequential seek: when a window closes an
utterance cleanly, the next window starts *there*. Windows overlap a little and
cost extra encoder passes; sentences stop being split, and accuracy improved as
a side effect (a name that came out "Wutter" across a boundary became "Mutter").

**3. Silence is not quiet.** On silence the model hallucinates confident
sentences and closes them after a couple of seconds — so seeking to the last
closed utterance crawled forward 2 s at a time (90 s of silence cost **32**
windows). Neither "no text" nor a minimum-advance floor is the right guard,
because the hallucinated text *is* text. Whisper's actual signal is the
probability of the no-speech token (`<|nocaptions|>`, 50362) in the distribution
predicted right after `<|startoftranscript|>`; above 0.6 the window is skipped
whole. 90 s of silence now costs 3 windows, and the real recording is unchanged.

## Speaker diarization

Opt-in, local, and — unlike everything else here — on the CPU.

```powershell
.\hexscribe.ps1 gespraech.ogg --diarize     # or the UI checkbox, or -F diarize=true
```

Everything runs through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx),
one of the very few packages in audio ML shipping a **`win_arm64` wheel** — which
is what makes this possible at all: the usual stack (`pyannote.audio`) needs
torch *and* torchaudio, and torchaudio has no wheels for this platform.

There are two engines behind the `diarize` seam, and `cordis.yml` picks. The
default is not the textbook one.

### The default: cluster the utterances

The textbook pipeline segments the audio first — pyannote finds speech regions,
an embedding network vectorises each region, clustering groups the vectors. It
has one structural problem here: **its regions are cut on its own criteria**, and
where a region spans a speaker change the embedding lands halfway between two
voices and takes the clustering with it.

But we are not asking "who spoke when". We are asking "who said this utterance",
and by then Whisper has already cut the audio on the speech it actually heard.
So the default engine embeds *those* and clusters them. Measured on the two
recordings in `test/fixtures`:

| | one-speaker file | three-speaker file |
|---|---|---|
| pyannote regions | **2 speakers** at its default 0.5 | **1 speaker** at every threshold |
| utterances | 1 speaker, 0.40 – 0.70 | **3 speakers, 0.45 – 0.70**, matching the oracle line for line |

There is no threshold that works for both under the old path — the one-voice file
splits at 0.5 while the three-voice file will not split until 0.4. Under the new
one, anything from 0.45 to 0.70 is correct on both, and the default 0.55 sits in
the middle of that band rather than at an edge.

The three-speaker recording is the harder case in every way: one voice is
whispered ~30 dB below the rest, which pyannote drops as non-speech **entirely**
(no turn at all for those 3.9 s), and one speaker says a single word. Both land
correctly here, because Whisper heard them and cut around them.

It is also far cheaper. There is no segmentation pass: the cost is one short
embedding per utterance.

| | before (pyannote) | now (utterances) |
|---|---|---|
| cost of `--diarize` | **~4.5×** the transcription | **~0.35×** |
| measured | 190 s audio → +39 s | 33.6 s audio → **+0.75 s** |

What it gives up is real and worth naming: a speaker change *inside* one
utterance is invisible, and overlapping speech cannot be represented. Neither was
usable before either — attribution has always collapsed a turn to one speaker per
utterance — but if you want turn-level boundaries independent of a transcript,
`default: sherpa` in `cordis.yml` brings the old engine back. Both are registered;
only the default changed.

### The embedding model matters more than the clustering

Five candidates were measured on the same audio, by embedding each known speaker
region and looking at the distances directly rather than inferring them from how
many clusters fell out the far end:

| model | verdict |
|---|---|
| `wespeaker_en_voxceleb_CAM++` (was default) | unusable here: put two stretches of **one** narrator 0.89 apart, while two *different* speakers sat at 0.49 |
| `wespeaker_en_voxceleb_CAM++_LM` | 3 speakers in the one-speaker file at every threshold |
| `wespeaker_en_voxceleb_resnet34_LM` | 1 speaker everywhere, on both files |
| `nemo_en_titanet_large` | put one speaker's whispered line 0.73 from her own normal voice — as far as a different person |
| **`3dspeaker_campplus_sv_zh_en`** | **the only one whose within-speaker distances all fell below its between-speaker ones**: 0.49 max within, 0.59 min between |

That gap is the whole margin the threshold lives in, and it is why the default
engine ships with a different embedding model than the pyannote one (which keeps
the English model it was measured with).

**There is still no speaker-count option, and that is a finding.** sherpa exposes
`num_clusters` to pin an exact count, and it does cut the dendrogram into that
many clusters — but complete linkage splits off tiny outlier clusters and the
frame-level finalisation then drops them, so the count that goes in is not the
count that comes out (asking for 2 or 3 returned 1; asking for 4 returned 2).
The exposed control is the clustering **threshold** (`speakerThreshold` on a
request, `threshold` in the `speakers` plugin config): lower finds more speakers.

**Complete linkage, not average or single.** Two groups merge only when *every*
pair across them is close enough. Single linkage would chain two voices together
through one ambiguous utterance sitting between them, which is precisely the
failure the old path exhibited.

**How labels are assigned.** The engines return turns; `speakers.ts` maps them
onto utterances by overlap, and each utterance takes the speaker it shares the
most time with (summed across that speaker's turns, so crosstalk does not hand
the label to whoever had the single longest stretch). Under the default engine
the turns *are* the utterances, so the mapping is one to one — but the step stays,
because it is what lets either engine sit behind the seam without anything
downstream noticing. An utterance overlapping nothing keeps no label rather than
a fabricated one, and one too short to embed (under 0.4 s) is left unlabelled for
the same reason: a guessed speaker on "Ja." is indistinguishable from a real
attribution once it is on screen.

**Neither engine touches the NPU** — no QAIRT context binary exists for these
models, so this is CPU work sitting next to NPU work. sherpa-onnx also loads its
own ONNX Runtime into the same process as our QNN one, which is the kind of thing
that breaks quietly, so `spikes/05_diarize_probe.py` runs a QNN session *after*
diarization to prove the NPU still works. It does.

## Audio that is not perfectly well-formed

Real recordings are not. A 1.31 h, 180 MB MP3 from a voice recorder had exactly
**one bad packet out of 196,800** — the last one, a truncated final frame, which
is entirely normal for MP3 — and the loader threw away the whole hour, because
PyAV's `container.decode()` raises on the first packet it cannot read:

```
InvalidDataError: [Errno 1094995529] Invalid data found when processing input:
'avcodec_send_packet()'
```

Decoding now goes packet by packet and skips what it cannot read, which is what
FFmpeg's own tools do. That file decodes in 17.6 s and transcribes in full.

The line to hold is between *blemished* and *broken*. Past 2% of packets the file
is refused outright, with the percentage in the message — skipping to the end of
a shredded file would produce a transcript of a recording nobody made. And below
that line the skip is **never silent**: the count reaches the API as `damage`,
the browser as a line above the transcript, and the CLI as a warning. Nothing
downstream can tell an incomplete transcript from a complete one by looking at
it, so the only place that can say so is the place that knows.

## IO binding: what it actually bought

**1.5%.** Worth writing down, because the reasoning that motivated it was wrong.

The decode loop re-feeds ~28 MB of cross-attention KV per token, plus a self-KV
ring that ORT copies out only to have it copied back in. Binding fixed all of
that: cross-KV is written by the encoder straight into the buffers the decoder
reads, the self-KV ring became two banks that are ping-ponged by rebinding, and
nothing is allocated per step (~3 GB of allocation churn removed over this file).

Measured on the same session with alternating rounds: **8.57 → 8.43 ms/Run**.
End to end, across 779 identical tokens, it is lost in the noise.

The profile explains why: 97% of a step is inside ORT's `Run`, and ORT's Python
API exposes no NPU allocator — `OrtValue` can only live on `cpu`, so the EP
stages its own device copies no matter what the caller binds. The remaining cost
is per-`Run` EP overhead, not data movement we control. HTP performance modes
(`burst`, `sustained_high_performance`, …) differ by less than run-to-run noise.

It is kept on by default (it is free, and steadier on memory), with
`ioBinding: false` selecting the unbound reference path — which exists so the
two can be compared, and is pinned by a test asserting both paths decode
byte-identical token streams.

## What this taught us about the Cordis model

Honest notes, since testing the philosophy is half the point.

**Held up well**

- *Services by name.* `cli.ts` injects `'asr'` and never learns that an NPU, a
  subprocess, or a quantized graph exists. Adding `engine-remote.ts` — which
  shares nothing with the NPU path — required no change to any consumer.
- *Registrations as effects.* `ctx.asr.register()` returns a disposer that rides
  on the **calling** plugin's fiber (Cordis rebinds `this.ctx` per accessing
  context). Unloading an engine plugin removes exactly its engine. Same for the
  worker process, and for waterfall listeners. No teardown bookkeeping anywhere.
- *Waterfall for policy.* A cache that answers without calling `next()`, and a
  glossary that wraps what `next()` returns, compose in either order without
  knowing about each other (`test/composition.test.ts`).
- *Config as composition.* Choosing an engine, enabling a post-processor, and
  pointing at a model directory are all `cordis.yml` edits validated by
  Schemastery before `apply` runs.
- *The registry pattern generalized.* `ctx.serve.route()` was written by copying
  the shape of `ctx.asr.register()` — hand back the disposer, let Cordis bind it
  to whoever called — and it worked unchanged for HTTP routes. Two unrelated
  registries, one idiom, no base class.
- *Fixing readiness in the service paid off twice.* The HTTP front-end never hit
  the boot race the CLI did, because `asr.transcribe()` waits internally. Had
  `ready()` been bolted onto the CLI instead, the second front-end would have
  reintroduced the same bug.

**Rubbed**

- *`inject` orders services, not contributions.* `asr` exists the moment its
  plugin loads — before any engine has registered into it. A long-running server
  never notices; a CLI that acts at boot hit it immediately and intermittently
  reported "no engine registered". The fix was to make readiness explicit
  (`asr.ready()`, awaited inside `transcribe()`), but the framework gives no
  ordering primitive for "wait until something has been contributed", so every
  registry-style service has to invent one.
- *One-shot programs fit awkwardly.* A CLI wants to run and exit; a composition
  wants to stay up. `cli.ts` ends by disposing the root fiber — which is the
  right thing (it stops the worker cleanly) but reads like a plugin reaching for
  the whole application.
- *…and a composition has no notion of which one it is.* Adding the server made
  that concrete: two front-ends with incompatible lifetimes, both valid entries
  in the same file. The loader's `disabled: !!js …` expression resolves it —
  the environment picks the mode at mount time, which is genuinely elegant — but
  a plugin cannot say "I am the application's purpose; the others are not," so
  the mode switch lives in the composition and in a launcher script.
  (Watch the YAML: `!!js !!process.env.X` fails to parse — the second `!!` reads
  as another tag. Write the comparison out.)
- *Seam shape follows the first implementation.* `Timing` was modeled on what
  the NPU engine can report; the second engine could not answer half of it, and
  the fields became optional. A second implementation early is the cheapest way
  to find that.
- *An event's signature is a guess about the future.* `transcript/finalize` was
  designed as text-in-text-out, which the glossary fit perfectly. Diarization is
  also post-processing, but it needs the *audio* — so the event had to grow the
  request as a parameter and every listener had to change. Cheap here (two
  listeners, one repo); in a plugin ecosystem, the same realisation is a
  breaking change to somebody else's code. Waterfall events are an API, and this
  one was designed one use case too narrowly.
- *An effect that fails asynchronously has nowhere to report.* The server binds
  inside `ctx.effect()`, so a failed `listen` is a rejected promise, not a thrown
  `apply`. Cordis routes such things to `ctx.logger` — and this composition
  attaches no console exporter, so a port collision produced a *live process
  with a dead socket and nothing on screen*. It cost a debugging detour before
  the cause was obvious. The fix was to write startup failures to stderr
  explicitly; the framework lesson is that "registrations are effects" quietly
  moves error reporting from the caller's stack to a logging seam you must
  remember to plug in.
- *A request field is not a capability.* `timestamps: true` travels through the
  seam to whichever engine is selected — but only the NPU engine can honor it;
  the remote engine silently returns one whole-file segment. Naming a service
  tells a consumer that a capability *exists*, not what that particular provider
  can do, and Cordis has no notion of a provider advertising its abilities.
  `describe()` is the obvious place to put one, and a front-end that adapts
  (rather than hopes) would need it.

## Layout

```
cordis.yml            the application
src/*.ts              Cordis plugins (TypeScript)
src/formats.ts        transcript renderers, shared by every front-end
src/serve/            HTTP front-end: http, router, auth, upload, openai, routes/
src/ui/               browser front-end: plugin + public/ (html, css, js modules)
scripts/ui-check.mjs  end-to-end UI check over the DevTools Protocol
scripts/reattach-check.mjs  proves a job survives the page that started it
scripts/shell-check.mjs     rail, history, settings, and the file picker
py/hexscribe_worker/  worker: audio.py, qnn.py, whisper_qnn.py, diarize.py,
                      diarize_utterances.py, worker.py
py/pyproject.toml     ARM64 venv (uv), pinned for win_arm64 wheel reality
py/tests/             mel filterbank, timestamp rules, engine (NPU tests self-skip)
spikes/               de-risking and measurement scripts, kept because their
                      numbers are cited above (01 NPU probe, 02 raw transcribe,
                      03 binding API probe, 04 decode profile + mode sweep)
test/                 composition guarantees
scripts/              model download
models/               downloaded assets (gitignored)
```

## Roadmap

- [x] Timestamps per utterance, with Whisper's timestamp rules and sequential seek
- [x] Silence skipped via the no-speech probability (cheaper and more accurate
      than the VAD model originally planned — no extra model, no extra download)
- [x] IO binding (kept; the profiling it produced was worth more than the 1.5%)
- [x] `serve` front-end: OpenAI-compatible `/v1/audio/{transcriptions,translations}`
- [x] Browser UI at `/` — drop a file, read utterances, export subtitles
- [x] Speaker diarization (opt-in; CPU, ~1.35× the wall clock)
- [x] Click-to-play: timestamps seek the audio, the spoken utterance highlights
- [x] Merge and split utterances, by hand or automatically
- [x] Name a speaker once and have the voice recognised in later recordings
- [x] Background jobs with measured progress, surviving a closed tab, and
      Windows notifications
- [x] A database of every run: transcripts, timings, logs and audio
- [x] Left rail with run history, and a settings modal with a danger zone
- [x] Transcribe files in place from disk, without uploading a copy
- [ ] Speaker *naming* — the labels are per-recording; recognising the same
      person across files needs an enrolled embedding per speaker, which the
      embedding model already produces
- [ ] Streaming responses (`stream: true`, SSE `transcript.text.delta`) — the
      segments already arrive incrementally through `asr/segment`; only the
      OpenAI event framing is missing
- [ ] Live microphone dictation with streaming partials
- [ ] CPU baseline for an honest speedup number
- [ ] Larger asset (`whisper-large-v3-turbo` QNN) as a quality option
- [ ] Word-level timing (the model can emit per-word timestamps via cross-attention
      alignment; utterance-level is what the token stream gives directly)

## Credits

Model assets: [Qualcomm AI Hub](https://huggingface.co/qualcomm/Whisper-Small-Quantized)
(`whisper_small_quantized`, w8a16, precompiled QNN ONNX). Decode loop follows the
reference in [qualcomm/ai-hub-models](https://github.com/qualcomm/ai-hub-models).
Framework: [Cordis](https://github.com/cordiverse/cordis).
