"""M5 spike: is offline speaker diarization viable next to the NPU engine?

Two questions, and the second one is the risk:

  1. Does sherpa-onnx (pyannote segmentation + speaker embeddings + clustering)
     produce sensible speaker turns for this audio, on this ARM64 machine?
  2. **Can it live in the same process as our QNN sessions?** sherpa-onnx bundles
     its own ONNX Runtime build. Two runtimes in one process is exactly the kind
     of thing that loads fine and then crashes, or silently breaks the QNN
     provider -- so the NPU engine is exercised *after* diarization here, not
     before.

usage: python spikes/05_diarize_probe.py <audio> [--speakers N]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))

MODELS = ROOT / "models"
SEGMENTATION = MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
EMBEDDING = MODELS / "wespeaker_en_voxceleb_CAM++.onnx"


def diarize(audio_path: str, speakers: int, threads: int = 1) -> list[tuple[float, float, int]]:
    import sherpa_onnx

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(SEGMENTATION)),
            num_threads=threads,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(EMBEDDING), num_threads=threads),
        clustering=sherpa_onnx.FastClusteringConfig(
            # Either the number of speakers is known, or a distance threshold
            # decides it. Exactly one of the two must be set.
            num_clusters=speakers if speakers > 0 else -1,
            threshold=0.5 if speakers <= 0 else 0.0,
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("sherpa-onnx rejected the diarization config")

    engine = sherpa_onnx.OfflineSpeakerDiarization(config)
    print(f"diarizer sample rate: {engine.sample_rate}", file=sys.stderr)

    from hexscribe_worker import audio as audio_mod

    samples = audio_mod.load_audio(audio_path)
    print(f"audio: {len(samples) / audio_mod.SAMPLE_RATE:.1f}s", file=sys.stderr)

    started = time.perf_counter()
    result = engine.process(samples).sort_by_start_time()
    elapsed = time.perf_counter() - started
    print(f"diarization took {elapsed:.2f}s (rtf {elapsed / (len(samples) / 16000):.3f})", file=sys.stderr)

    return [(r.start, r.end, r.speaker) for r in result]


def check_npu_still_works() -> None:
    """The whole point of question 2: QNN must survive sherpa's runtime."""
    from hexscribe_worker.qnn import npu_device, npu_session

    device = npu_device()
    print(f"\nQNN NPU device after sherpa-onnx: {device is not None}", file=sys.stderr)
    if device is None:
        print("!! the NPU is no longer reachable -- separate processes required", file=sys.stderr)
        return

    model_dir = (
        MODELS
        / "whisper-small-qnn"
        / "whisper_small_quantized-precompiled_qnn_onnx-w8a16-qualcomm_snapdragon_x_elite"
    )
    session = npu_session(model_dir / "encoder.onnx")
    print(f"encoder session providers: {session.get_providers()}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--speakers", type=int, default=0, help="known speaker count; 0 = decide automatically")
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--skip-npu-check", action="store_true")
    args = ap.parse_args()

    for path in (SEGMENTATION, EMBEDDING):
        if not path.exists():
            print(f"!! missing model: {path}", file=sys.stderr)
            return 2

    turns = diarize(args.audio, args.speakers, args.threads)
    speakers = sorted({speaker for _, _, speaker in turns})
    print(f"\n{len(turns)} turns, {len(speakers)} speakers: {speakers}")
    for start, end, speaker in turns[:12]:
        print(f"  [{start:7.2f} -> {end:7.2f}] speaker_{speaker}")

    if not args.skip_npu_check:
        check_npu_still_works()
    return 0


if __name__ == "__main__":
    sys.exit(main())
