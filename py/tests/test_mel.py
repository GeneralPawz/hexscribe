"""Pin the numpy mel filterbank against OpenAI's own.

`audio.py` reimplements the filterbank because the reference implementations
(librosa, transformers' feature extractor) are unavailable or unaffordable on
win_arm64. A silently wrong filterbank would not crash -- it would just degrade
accuracy -- so it is checked against the matrix Whisper itself ships
(`whisper/assets/mel_filters.npz`, vendored here at 4 KB).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hexscribe_worker import audio  # noqa: E402

REFERENCE = Path(__file__).parent / "data" / "mel_filters.npz"


@pytest.mark.skipif(not REFERENCE.exists(), reason="reference filters not vendored")
def test_mel_filters_match_openai() -> None:
    with np.load(REFERENCE, allow_pickle=False) as data:
        expected = data["mel_80"]

    actual = audio.mel_filters(n_mels=80, n_fft=400, sample_rate=16000)

    assert actual.shape == expected.shape
    np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-7)


def test_log_mel_shape_and_range() -> None:
    # 1 s of a 440 Hz tone; the rest of the 30 s window is padding.
    t = np.arange(audio.SAMPLE_RATE, dtype=np.float32) / audio.SAMPLE_RATE
    tone = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)

    mel = audio.log_mel_spectrogram(tone)

    assert mel.shape == (audio.N_MELS, audio.N_FRAMES)
    assert mel.dtype == np.float32
    # Whisper floors the spectrum 8 (log10) units below its peak and then scales
    # by 1/4, so the dynamic range is exactly 2.0 whenever the floor is reached.
    # It does not cap the top: a loud input legitimately exceeds 1.0.
    assert mel.max() - mel.min() == pytest.approx(2.0, abs=1e-5)


def test_chunking_covers_every_sample() -> None:
    audio_in = np.arange(audio.CHUNK_SAMPLES * 2 + 1234, dtype=np.float32)
    chunks = audio.chunk_audio(audio_in)

    assert len(chunks) == 3
    assert sum(len(c) for c in chunks) == len(audio_in)
    np.testing.assert_array_equal(np.concatenate(chunks), audio_in)
