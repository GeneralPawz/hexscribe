"""M0/M3 spike: transcribe a file on the NPU and report timings.

usage: python spikes/02_transcribe.py <audio> [--lang de] [--no-io-binding] [--no-timestamps]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))

from hexscribe_worker import audio as audio_mod  # noqa: E402
from hexscribe_worker.whisper_qnn import WhisperQnn  # noqa: E402

MODEL_DIR = (
    ROOT
    / "models"
    / "whisper-small-qnn"
    / "whisper_small_quantized-precompiled_qnn_onnx-w8a16-qualcomm_snapdragon_x_elite"
)
TOKENIZER = ROOT / "models" / "whisper-small-tokenizer" / "tokenizer.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--lang", default=None, help="force a language, e.g. de (default: auto-detect)")
    ap.add_argument("--task", default="transcribe", choices=["transcribe", "translate"])
    ap.add_argument("--limit", type=float, default=None, help="only transcribe the first N seconds")
    ap.add_argument("--no-io-binding", action="store_true", help="use the unbound reference path")
    ap.add_argument("--no-timestamps", action="store_true", help="force <|notimestamps|>")
    args = ap.parse_args()

    t0 = time.perf_counter()
    engine = WhisperQnn(MODEL_DIR, TOKENIZER, io_binding=not args.no_io_binding)
    print(
        f"load       : {engine.model_name} in {time.perf_counter() - t0:.2f}s "
        f"(io_binding={engine.io_binding}, timestamps={not args.no_timestamps})",
        file=sys.stderr,
    )

    pcm = audio_mod.load_audio(args.audio)
    if args.limit:
        pcm = pcm[: int(args.limit * audio_mod.SAMPLE_RATE)]
    print(f"audio      : {len(pcm) / audio_mod.SAMPLE_RATE:.1f}s", file=sys.stderr)

    segments, timing = engine.transcribe(
        pcm, language=args.lang, task=args.task, timestamps=not args.no_timestamps
    )

    for seg in segments:
        print(f"[{seg.start:7.2f} -> {seg.end:7.2f}] {seg.text}")
    print("\n" + json.dumps(timing.as_dict(), indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
