"""Hardware tests: skipped unless the NPU and the model assets are present.

The one that matters is the equivalence check. The bound decode path rebinds 48
KV tensors per step and ping-pongs two cache banks; a wrong bank swap would not
crash, it would quietly corrupt attention and degrade the transcript. So the two
paths must produce byte-identical token streams from the same audio.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "py"))

from hexscribe_worker import audio as audio_mod  # noqa: E402
from hexscribe_worker.qnn import npu_device  # noqa: E402
from hexscribe_worker.whisper_qnn import WhisperQnn  # noqa: E402
from local_audio import find_test_audio  # noqa: E402

MODEL_DIR = (
    ROOT
    / "models"
    / "whisper-small-qnn"
    / "whisper_small_quantized-precompiled_qnn_onnx-w8a16-qualcomm_snapdragon_x_elite"
)
TOKENIZER = ROOT / "models" / "whisper-small-tokenizer" / "tokenizer.json"

pytestmark = pytest.mark.skipif(
    not (MODEL_DIR.exists() and TOKENIZER.exists() and npu_device() is not None),
    reason="needs the Hexagon NPU and downloaded model assets",
)


def sample_audio(seconds: float = 30.0) -> np.ndarray:
    """Deterministic non-silence. Content does not matter, reproducibility does."""
    rng = np.random.default_rng(7)
    t = np.arange(int(seconds * audio_mod.SAMPLE_RATE), dtype=np.float32) / audio_mod.SAMPLE_RATE
    speech_like = 0.3 * np.sin(2 * np.pi * 180 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 3 * t))
    return (speech_like + 0.01 * rng.standard_normal(t.shape)).astype(np.float32)


@pytest.fixture(scope="module")
def audio() -> np.ndarray:
    return sample_audio()


def test_bound_and_unbound_paths_agree(audio: np.ndarray) -> None:
    bound = WhisperQnn(MODEL_DIR, TOKENIZER, io_binding=True)
    unbound = WhisperQnn(MODEL_DIR, TOKENIZER, io_binding=False)

    a = bound.transcribe_chunk(audio, language="de", timestamps=True)
    b = unbound.transcribe_chunk(audio, language="de", timestamps=True)

    assert a == b, "io binding changed the decoded tokens -- the cache ping-pong is wrong"


def test_sessions_actually_run_on_the_npu() -> None:
    engine = WhisperQnn(MODEL_DIR, TOKENIZER)

    assert "QNNExecutionProvider" in engine.encoder.get_providers()
    assert "QNNExecutionProvider" in engine.decoder.get_providers()


def test_timestamped_segments_are_ordered_and_within_the_audio(audio: np.ndarray) -> None:
    engine = WhisperQnn(MODEL_DIR, TOKENIZER)
    duration = len(audio) / audio_mod.SAMPLE_RATE

    segments, timing = engine.transcribe(audio, language="de", timestamps=True)

    assert timing.audio_seconds == pytest.approx(duration)
    for previous, segment in zip(segments, segments[1:]):
        assert segment.start >= previous.start
    for segment in segments:
        assert 0.0 <= segment.start <= segment.end <= duration + 1e-6


real_audio = pytest.mark.skipif(find_test_audio() is None, reason="no local test recording")


@real_audio
def test_a_real_recording_transcribes_into_ordered_utterances() -> None:
    """Structural assertions only: the recording is private, so nothing here
    inspects or prints what was said."""
    engine = WhisperQnn(MODEL_DIR, TOKENIZER)
    samples = audio_mod.load_audio(find_test_audio())
    duration = len(samples) / audio_mod.SAMPLE_RATE
    assert duration > audio_mod.CHUNK_SECONDS, "expected more than one decode window"

    segments, timing = engine.transcribe(samples, language="de", timestamps=True)

    assert segments, "real speech should produce at least one utterance"
    assert all(segment.text.strip() for segment in segments)
    assert timing.chunks >= 2
    assert timing.tokens > 0
    for previous, segment in zip(segments, segments[1:]):
        assert segment.start >= previous.start
    for segment in segments:
        assert 0.0 <= segment.start < segment.end <= duration + 1e-6


@real_audio
def test_a_real_recording_survives_the_bound_and_unbound_paths_alike() -> None:
    samples = audio_mod.load_audio(find_test_audio())[: audio_mod.CHUNK_SAMPLES]

    bound = WhisperQnn(MODEL_DIR, TOKENIZER, io_binding=True)
    unbound = WhisperQnn(MODEL_DIR, TOKENIZER, io_binding=False)

    assert bound.transcribe_chunk(samples, language="de") == unbound.transcribe_chunk(
        samples, language="de"
    )


def test_seek_terminates_on_audio_that_decodes_to_nothing() -> None:
    """Silence must not stall the seek loop: a window that closes at 0 s advances fully."""
    engine = WhisperQnn(MODEL_DIR, TOKENIZER)
    silence = np.zeros(int(90 * audio_mod.SAMPLE_RATE), dtype=np.float32)

    _, timing = engine.transcribe(silence, language="de", timestamps=True)

    # 90 s of silence is exactly 3 windows: a window with no text is skipped
    # whole, rather than being re-read from its first (empty) utterance end.
    assert timing.chunks == 3
