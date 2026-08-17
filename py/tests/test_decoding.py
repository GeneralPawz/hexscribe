"""Whisper's timestamp rules and segment parsing, without touching the NPU.

The rules decide *whether a timestamp is emitted at all* -- plain argmax never
emits one after the first -- so they are the difference between an SRT of real
utterances and one of 30 s blocks. They are pure logic over a logits vector, so
they are tested here directly on an engine built without sessions or a model.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hexscribe_worker.whisper_qnn import WhisperQnn  # noqa: E402

VOCAB = 51865
EOT = 50257
NO_TIMESTAMPS = 50363
TIMESTAMP_BEGIN = 50364


@pytest.fixture
def engine() -> WhisperQnn:
    """A WhisperQnn with only the fields the sampler and parser read.

    Built with __new__ so no ONNX session, tokenizer, or NPU is involved; the
    alternative is not testing this logic at all outside Snapdragon hardware.
    """
    self = WhisperQnn.__new__(WhisperQnn)
    self.eot = EOT
    self.no_timestamps = NO_TIMESTAMPS
    self.timestamp_begin = TIMESTAMP_BEGIN
    self.timestamp_step = 0.02
    self._max_initial_timestamp = 50
    self._first_special = EOT
    self._logit_scale = 1.0
    self._logit_zp = 0
    self.decode_text = lambda tokens: " ".join(str(t) for t in tokens)  # type: ignore[method-assign]
    return self


def logits(**values: float) -> np.ndarray:
    raw = np.zeros(VOCAB, dtype=np.uint16)
    for key, value in values.items():
        raw[int(key[1:])] = int(value)
    return raw


def test_first_sampled_token_must_be_an_early_timestamp(engine: WhisperQnn) -> None:
    # A very confident text token still loses: the transcript opens on a time.
    raw = logits(t100=900)
    raw[TIMESTAMP_BEGIN + 10] = 5
    raw[TIMESTAMP_BEGIN + 900] = 400  # 18 s in -- beyond max_initial

    picked = engine._next_token(raw, [], timestamps=True)

    assert picked == TIMESTAMP_BEGIN + 10


def test_an_opening_timestamp_must_be_followed_by_text(engine: WhisperQnn) -> None:
    raw = logits(t100=5)
    raw[TIMESTAMP_BEGIN + 200] = 900

    picked = engine._next_token(raw, [TIMESTAMP_BEGIN], timestamps=True)

    assert picked == 100


def test_a_closing_timestamp_must_be_followed_by_a_timestamp(engine: WhisperQnn) -> None:
    raw = logits(t100=900)
    raw[TIMESTAMP_BEGIN + 30] = 5

    picked = engine._next_token(raw, [TIMESTAMP_BEGIN, 100, TIMESTAMP_BEGIN + 20], timestamps=True)

    assert picked >= TIMESTAMP_BEGIN


def test_timestamps_never_move_backwards(engine: WhisperQnn) -> None:
    raw = np.zeros(VOCAB, dtype=np.uint16)
    raw[TIMESTAMP_BEGIN + 5] = 900  # earlier than the last one: forbidden
    raw[TIMESTAMP_BEGIN + 40] = 100

    picked = engine._next_token(raw, [TIMESTAMP_BEGIN, 100, TIMESTAMP_BEGIN + 20], timestamps=True)

    assert picked == TIMESTAMP_BEGIN + 40


def test_aggregate_timestamp_mass_beats_a_single_text_token(engine: WhisperQnn) -> None:
    # No single timestamp beats the text token, but 1501 of them together do.
    raw = logits(t200=5)
    raw[TIMESTAMP_BEGIN:] = 1

    picked = engine._next_token(raw, [TIMESTAMP_BEGIN, 200], timestamps=True)

    assert picked >= TIMESTAMP_BEGIN


def test_a_confident_text_token_still_wins(engine: WhisperQnn) -> None:
    raw = logits(t200=12)
    raw[TIMESTAMP_BEGIN:] = 1

    picked = engine._next_token(raw, [TIMESTAMP_BEGIN, 200], timestamps=True)

    assert picked == 200


def test_without_timestamps_it_is_plain_argmax(engine: WhisperQnn) -> None:
    raw = logits(t200=12)
    raw[TIMESTAMP_BEGIN:] = 1

    assert engine._next_token(raw, [], timestamps=False) == 200


# --- segment parsing -------------------------------------------------------


def ts(seconds: float) -> int:
    return TIMESTAMP_BEGIN + int(round(seconds / 0.02))


def test_paired_timestamps_become_segments(engine: WhisperQnn) -> None:
    tokens = [ts(0.0), 1, 2, ts(2.5), ts(2.5), 3, ts(6.0)]

    segments, last_closed = engine.parse_segments(tokens, offset=30.0, chunk_end=60.0)

    assert [(s.start, s.end, s.text) for s in segments] == [(30.0, 32.5, "1 2"), (32.5, 36.0, "3")]
    assert last_closed == 6.0


def test_dangling_text_is_kept_but_does_not_move_the_seek(engine: WhisperQnn) -> None:
    # The window filled up mid-utterance: the words survive, but `last_closed`
    # stays at the last *closed* pair so the caller re-decodes from there.
    tokens = [ts(0.0), 1, ts(4.0), ts(4.0), 2, 3]

    segments, last_closed = engine.parse_segments(tokens, offset=0.0, chunk_end=30.0)

    assert [(s.start, s.end) for s in segments] == [(0.0, 4.0), (4.0, 30.0)]
    assert last_closed == 4.0


def test_segment_end_never_runs_past_the_window(engine: WhisperQnn) -> None:
    tokens = [ts(0.0), 1, ts(29.98)]

    segments, _ = engine.parse_segments(tokens, offset=0.0, chunk_end=12.0)

    assert segments[0].end == 12.0
