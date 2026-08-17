"""Line-delimited JSON worker: the NPU engine, addressable from another process.

Protocol (one JSON object per line, UTF-8):

    stdin   {"id": 1, "method": "transcribe", "params": {"path": "...", "language": "de"}}
    stdout  {"event": "ready",  "data": {...}}                 # once, at startup
            {"id": 1, "event": "segment", "data": {...}}       # zero or more
            {"id": 1, "result": {...}}                         # exactly one, or:
            {"id": 1, "error": {"code": "...", "message": "..."}}

Methods: `info` (diagnostics, never loads the model), `load` (force model load),
`transcribe` (params: path, language, task).

stdout is protocol-only. Everything else -- our logs and the QNN backend's own
`DSP_INFO ...` chatter -- goes to stderr, and the reader is expected to skip
lines it cannot parse anyway.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from . import audio as audio_mod
from .diarize import DEFAULT_THREADS, DiarizationUnavailable, Diarizer
from .diarize_utterances import Utterance, UtteranceDiarizer
from .qnn import NpuUnavailable, describe
from .whisper_qnn import Segment, WhisperQnn


def _emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


class Worker:
    def __init__(
        self,
        model_dir: Path,
        tokenizer: Path,
        *,
        io_binding: bool = True,
        diarizer: Diarizer | None = None,
        utterance_diarizer: UtteranceDiarizer | None = None,
    ) -> None:
        self.model_dir = model_dir
        self.tokenizer = tokenizer
        self.io_binding = io_binding
        self.diarizer = diarizer
        self.utterance_diarizer = utterance_diarizer
        self._engine: WhisperQnn | None = None

    def engine(self) -> WhisperQnn:
        if self._engine is None:
            _log(f"loading {self.model_dir.name}")
            self._engine = WhisperQnn(self.model_dir, self.tokenizer, io_binding=self.io_binding)
            _log("model ready")
        return self._engine

    # --- methods ---------------------------------------------------------

    def info(self, _params: dict) -> dict:
        info = describe()
        info.update(
            {
                "model_dir": str(self.model_dir),
                "model_loaded": self._engine is not None,
                "model_name": self._engine.model_name if self._engine else None,
                "diarization_available": bool(self.diarizer and self.diarizer.available()),
                "utterance_diarization_available": bool(
                    self.utterance_diarizer and self.utterance_diarizer.available()
                ),
            }
        )
        return info

    def diarize(self, params: dict) -> dict:
        """Who spoke when. Runs on the CPU and costs multiples of transcription."""
        if self.diarizer is None:
            raise DiarizationUnavailable("this worker was started without diarization models")
        threshold = params.get("threshold")
        turns, timing = self.diarizer.diarize(
            params["path"], threshold=float(threshold) if threshold is not None else None
        )
        _log(f"diarized {timing['audio_seconds']}s -> {timing['speakers']} speakers in {timing['total_ms']:.0f}ms")
        return {"turns": [turn.as_dict() for turn in turns], "timing": timing}

    def diarize_utterances(self, params: dict) -> dict:
        """Who said each utterance. Needs the utterances, so it runs after ASR."""
        if self.utterance_diarizer is None:
            raise DiarizationUnavailable("this worker was started without an embedding model")
        threshold = params.get("threshold")
        utterances = [
            Utterance(start=float(item["start"]), end=float(item["end"]))
            for item in params.get("utterances") or []
        ]
        turns, timing, profiles = self.utterance_diarizer.diarize(
            params["path"], utterances, threshold=float(threshold) if threshold is not None else None
        )
        _log(
            f"clustered {timing['turns']} utterances -> {timing['speakers']} speakers "
            f"in {timing['total_ms']:.0f}ms"
        )
        return {
            "turns": [turn.as_dict() for turn in turns],
            "timing": timing,
            "profiles": profiles,
        }

    def compress_audio(self, params: dict) -> dict:
        """Re-encode audio small enough to be worth keeping."""
        started = time.perf_counter()
        result = audio_mod.compress_to_opus(params["path"], params["out"])
        result["total_ms"] = round((time.perf_counter() - started) * 1000, 1)
        _log(f"compressed {result['seconds']}s to {result['bytes'] / 1024:.0f} kB")
        return result

    def load(self, _params: dict) -> dict:
        engine = self.engine()
        return {"model_name": engine.model_name, "decode_window": engine.decode_window}

    def transcribe(self, params: dict, request_id: Any) -> dict:
        path = params["path"]
        language = params.get("language") or None
        task = params.get("task", "transcribe")
        timestamps = params.get("timestamps", True)

        engine = self.engine()

        damage: dict = {}

        def note_damage(skipped: int, packets: int) -> None:
            damage.update({"skipped_packets": skipped, "total_packets": packets})
            _log(f"skipped {skipped} of {packets} damaged audio packets")

        pcm = audio_mod.load_audio(path, on_damage=note_damage)

        # How long the audio is, as soon as it is known and before any of it is
        # transcribed. It is the denominator of every progress report there is:
        # segments arrive with an `end` time, and "34 minutes of 79" needs the 79.
        _emit(
            {
                "id": request_id,
                "event": "audio",
                "data": {"seconds": round(len(pcm) / audio_mod.SAMPLE_RATE, 3)},
            }
        )

        def stream(segment: Segment) -> None:
            # The consumer sees each utterance as it lands, not at the end.
            _emit(
                {
                    "id": request_id,
                    "event": "segment",
                    "data": {
                        "index": segment.index,
                        "start": segment.start,
                        "end": segment.end,
                        "text": segment.text,
                    },
                }
            )

        segments, timing = engine.transcribe(
            pcm, language=language, task=task, timestamps=timestamps, on_segment=stream
        )

        return {
            "segments": [
                {"index": s.index, "start": s.start, "end": s.end, "text": s.text} for s in segments
            ],
            "text": " ".join(s.text for s in segments if s.text).strip(),
            "timing": timing.as_dict(),
            "language": language,
            "timestamps": timestamps,
            "model": engine.model_name,
            # Only present when something was dropped, so a caller can say so
            # rather than presenting a transcript with an unannounced hole.
            **({"damage": damage} if damage else {}),
        }

    # --- loop ------------------------------------------------------------

    def serve(self) -> int:
        _emit({"event": "ready", "data": {"pid": __import__("os").getpid(), **self.info({})}})
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                _log(f"ignoring non-JSON line: {line[:120]!r}")
                continue

            request_id = message.get("id")
            method = message.get("method")
            params = message.get("params") or {}
            if method == "shutdown":
                _emit({"id": request_id, "result": {"ok": True}})
                return 0
            try:
                if method == "info":
                    result = self.info(params)
                elif method == "load":
                    result = self.load(params)
                elif method == "transcribe":
                    result = self.transcribe(params, request_id)
                elif method == "diarize":
                    result = self.diarize(params)
                elif method == "diarize_utterances":
                    result = self.diarize_utterances(params)
                elif method == "compress_audio":
                    result = self.compress_audio(params)
                else:
                    raise ValueError(f"unknown method {method!r}")
                _emit({"id": request_id, "result": result})
            except NpuUnavailable as exc:
                _emit({"id": request_id, "error": {"code": "NPU_UNAVAILABLE", "message": str(exc)}})
            except DiarizationUnavailable as exc:
                _emit({"id": request_id, "error": {"code": "DIARIZATION_UNAVAILABLE", "message": str(exc)}})
            except audio_mod.UndecodableAudio as exc:
                # A user-fixable problem with the file, not a bug in the worker:
                # it deserves its own code so the front-end can say so plainly.
                _emit({"id": request_id, "error": {"code": "UNDECODABLE_AUDIO", "message": str(exc)}})
            except FileNotFoundError as exc:
                _emit({"id": request_id, "error": {"code": "NOT_FOUND", "message": str(exc)}})
            except Exception as exc:  # noqa: BLE001 - the boundary reports, never dies
                _log(traceback.format_exc())
                _emit(
                    {
                        "id": request_id,
                        "error": {"code": "WORKER_ERROR", "message": f"{type(exc).__name__}: {exc}"},
                    }
                )
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="hexscribe-worker")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument(
        "--no-io-binding",
        action="store_true",
        help="use the unbound reference decode path (see whisper_qnn._Buffers)",
    )
    ap.add_argument("--segmentation-model", help="pyannote segmentation ONNX; enables diarization")
    ap.add_argument("--embedding-model", help="speaker embedding ONNX; enables diarization")
    ap.add_argument("--diarization-threads", type=int, default=DEFAULT_THREADS)
    ap.add_argument(
        "--utterance-embedding-model",
        help="speaker embedding ONNX for utterance-level diarization; "
        "defaults to --embedding-model when omitted",
    )
    args = ap.parse_args()

    # Windows consoles default to cp1252; the protocol and German text are UTF-8.
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")

    diarizer = None
    if args.segmentation_model and args.embedding_model:
        diarizer = Diarizer(
            args.segmentation_model, args.embedding_model, threads=args.diarization_threads
        )

    # Utterance-level diarization needs no segmentation model, only embeddings.
    utterance_model = args.utterance_embedding_model or args.embedding_model
    utterance_diarizer = (
        UtteranceDiarizer(utterance_model, threads=args.diarization_threads)
        if utterance_model
        else None
    )

    worker = Worker(
        Path(args.model_dir),
        Path(args.tokenizer),
        io_binding=not args.no_io_binding,
        diarizer=diarizer,
        utterance_diarizer=utterance_diarizer,
    )
    return worker.serve()


if __name__ == "__main__":
    sys.exit(main())
