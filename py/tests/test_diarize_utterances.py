"""Clustering utterances into speakers.

The clustering is the whole rule: given distances between voices, it decides how
many people are in the room. It is pure numpy over an embedding matrix, so it is
tested directly with constructed vectors -- no models, no audio, no NPU.

The cases below are the ones that were wrong in the pipeline this replaced: two
voices chained together through something that sat between them, and a single
voice split in two because one stretch of it sounded different from the rest.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hexscribe_worker.diarize_utterances import (  # noqa: E402
    DEFAULT_THRESHOLD,
    Utterance,
    UtteranceDiarizer,
    cluster,
)


def unit(*values: float) -> np.ndarray:
    vector = np.array(values, dtype=np.float64)
    return vector / np.linalg.norm(vector)


def groups(labels: list[int]) -> set[frozenset[int]]:
    """Labels as a partition, so a test does not depend on which id won."""
    out: dict[int, set[int]] = {}
    for index, label in enumerate(labels):
        out.setdefault(label, set()).add(index)
    return {frozenset(members) for members in out.values()}


def test_identical_voices_are_one_speaker():
    voice = unit(1, 0, 0)
    assert cluster(np.array([voice, voice, voice]), DEFAULT_THRESHOLD) == [0, 0, 0]


def test_orthogonal_voices_are_separate_speakers():
    vectors = np.array([unit(1, 0, 0), unit(0, 1, 0), unit(0, 0, 1)])
    assert len(set(cluster(vectors, DEFAULT_THRESHOLD))) == 3


def test_one_voice_is_not_split_by_a_stretch_that_sounds_different():
    # The whispered line: the same person, further from her own normal voice
    # (0.49 measured) than utterances of one speaker usually are -- but still
    # nearer than any other speaker (0.59 measured).
    normal = unit(1, 0, 0)
    whispered = unit(1, 0.8, 0)  # cosine distance ~0.22 from `normal`
    assert cluster(np.array([normal, normal, whispered]), DEFAULT_THRESHOLD) == [0, 0, 0]


def test_two_voices_do_not_chain_through_something_between_them():
    # Single linkage would merge all three: A-B and B-C are each close enough,
    # so the chain joins A to C even though A and C are far apart. Complete
    # linkage refuses, which is why it is the merge rule.
    a = unit(1, 0, 0)
    between = unit(1, 1, 0)
    c = unit(0, 1, 0)

    labels = cluster(np.array([a, between, c]), 0.35)

    assert len(set(labels)) > 1, "A and C are 1.0 apart and must not end up together"
    assert labels[0] != labels[2]


def test_the_threshold_is_what_decides_the_count():
    # Distances here: a-b 0.11, b-c 0.55, a-c 1.00. Under complete linkage the
    # pair {a,b} sits 1.00 from c, because the *worse* of the two is what counts.
    vectors = np.array([unit(1, 0, 0), unit(1, 0.5, 0), unit(0, 1, 0)])

    assert len(set(cluster(vectors, 1.05))) == 1, "generous: everyone is one person"
    assert groups(cluster(vectors, 0.6)) == {frozenset({0, 1}), frozenset({2})}
    assert len(set(cluster(vectors, 0.05))) == 3, "strict: nobody is anybody else"


def test_edge_cases_do_not_raise():
    assert cluster(np.zeros((0, 3)), DEFAULT_THRESHOLD) == []
    assert cluster(np.array([unit(1, 0, 0)]), DEFAULT_THRESHOLD) == [0]


def test_speakers_are_numbered_by_who_speaks_first(monkeypatch):
    # SPEAKER_00 must be whoever talks first, not whichever cluster id fell out
    # of the algorithm -- the label is shown to a person reading top to bottom.
    diarizer = UtteranceDiarizer("nonexistent.onnx")
    voices = {0: unit(0, 1, 0), 1: unit(0, 1, 0), 2: unit(1, 0, 0)}
    calls = {"n": 0}

    def fake_embed(_clip):
        vector = voices[calls["n"]]
        calls["n"] += 1
        return vector

    monkeypatch.setattr(diarizer, "embed", fake_embed)

    samples = np.ones(16000 * 30, dtype=np.float32)
    turns, timing, profiles = diarizer.diarize_samples(
        samples,
        [Utterance(0, 5), Utterance(5, 10), Utterance(10, 15)],
    )

    assert [turn.speaker for turn in turns] == ["SPEAKER_00", "SPEAKER_00", "SPEAKER_01"]
    assert timing["speakers"] == 2
    assert timing["turns"] == 3

    # And one voice print per speaker, carrying the label it belongs to, so a
    # caller can join a name to a voice without re-deriving the grouping.
    assert [p["speaker"] for p in profiles] == ["SPEAKER_00", "SPEAKER_01"]
    assert profiles[0]["utterances"] == 2
    assert profiles[0]["seconds"] == 10
    assert abs(np.linalg.norm(profiles[0]["embedding"]) - 1) < 1e-5, "a unit vector"


def test_a_voice_print_is_weighted_toward_the_longer_utterances(monkeypatch):
    # A four-second sentence is more evidence of what someone sounds like than a
    # one-second interjection; treating them equally lets a clipped "ja" pull the
    # print around.
    diarizer = UtteranceDiarizer("nonexistent.onnx")
    vectors = [unit(1, 0, 0), unit(0, 1, 0)]
    calls = {"n": 0}

    def fake_embed(_clip):
        vector = vectors[calls["n"]]
        calls["n"] += 1
        return vector

    monkeypatch.setattr(diarizer, "embed", fake_embed)

    samples = np.ones(16000 * 40, dtype=np.float32)
    _turns, _timing, profiles = diarizer.diarize_samples(
        samples,
        [Utterance(0, 30), Utterance(30, 31)],  # 30 s against 1 s, same cluster
        threshold=2.0,
    )

    assert len(profiles) == 1
    print_vector = np.array(profiles[0]["embedding"])
    assert print_vector[0] > print_vector[1] * 5, "the long utterance dominates"


def test_an_utterance_too_short_to_embed_is_left_unlabelled(monkeypatch):
    # A guessed speaker on "Ja." is worse than none: it is indistinguishable
    # from a real attribution once it is on screen.
    diarizer = UtteranceDiarizer("nonexistent.onnx")
    monkeypatch.setattr(diarizer, "embed", lambda _clip: unit(1, 0, 0))

    samples = np.ones(16000 * 20, dtype=np.float32)
    turns, timing, _profiles = diarizer.diarize_samples(
        samples,
        [Utterance(0, 5), Utterance(5.0, 5.2), Utterance(6, 11)],
    )

    assert timing["too_short"] == 1
    assert len(turns) == 2
    assert all(turn.end - turn.start > 1 for turn in turns)


def test_a_recording_with_no_usable_utterances_says_so_rather_than_failing():
    diarizer = UtteranceDiarizer("nonexistent.onnx")
    turns, timing, profiles = diarizer.diarize_samples(np.ones(16000, dtype=np.float32), [])

    assert turns == []
    assert timing["speakers"] == 0
    assert profiles == []
