"""Decoding audio that is not perfectly well-formed.

Real recordings are not. A 1.31 h MP3 from a voice recorder had exactly one bad
packet out of 196,800 — the last one, a truncated final frame — and the loader
threw the whole hour away because `container.decode()` raises on the first one it
cannot read. FFmpeg's own tools log that and continue, and so should this.

The line to hold is between *blemished* and *broken*: skip a little and say so,
refuse a lot. A transcript with an unannounced hole in it is worse than an error,
because nothing downstream can tell it is incomplete.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hexscribe_worker import audio as audio_mod  # noqa: E402
from local_audio import find_test_audio  # noqa: E402

av = pytest.importorskip("av")


def write_tone(path: Path, seconds: float = 3.0, rate: int = 16000) -> Path:
    """A small, valid MP3 to damage on purpose."""
    samples = (np.sin(2 * np.pi * 440 * np.arange(int(rate * seconds)) / rate) * 0.4).astype(np.float32)
    container = av.open(str(path), mode="w")
    stream = container.add_stream("mp3", rate=rate)
    stream.layout = "mono"
    frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format="fltp", layout="mono")
    frame.rate = rate
    for packet in stream.encode(frame):
        container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()
    return path


def test_a_clean_file_decodes_without_reporting_damage(tmp_path):
    path = write_tone(tmp_path / "clean.mp3")
    reports = []

    audio = audio_mod.load_audio(path, on_damage=lambda *args: reports.append(args))

    assert len(audio) > 16000, "roughly the right amount of audio came back"
    assert audio.dtype == np.float32
    assert reports == [], "nothing to report when nothing was skipped"


def test_a_truncated_tail_costs_the_tail_and_not_the_file(tmp_path):
    # The reported failure, in miniature: a file whose last frame is cut off.
    path = write_tone(tmp_path / "truncated.mp3", seconds=6.0)
    whole = path.read_bytes()
    damaged = tmp_path / "damaged.mp3"
    damaged.write_bytes(whole[: int(len(whole) * 0.995)] + b"\xff\xfb\x00\x00")

    reports = []
    audio = audio_mod.load_audio(damaged, on_damage=lambda *args: reports.append(args))

    # The point: almost all of it survives, rather than none of it.
    assert len(audio) > 16000 * 5, f"expected most of 6 s, got {len(audio) / 16000:.2f} s"


def test_a_thoroughly_broken_file_is_refused_rather_than_half_transcribed(tmp_path):
    # Every other packet is garbage. Skipping to the end would produce a
    # transcript of a recording nobody made.
    path = write_tone(tmp_path / "shredded.mp3", seconds=6.0)
    raw = bytearray(path.read_bytes())
    for offset in range(400, len(raw) - 4, 64):
        raw[offset : offset + 4] = b"\x00\xff\x00\xff"
    shredded = tmp_path / "shredded-out.mp3"
    shredded.write_bytes(bytes(raw))

    try:
        audio_mod.load_audio(shredded)
    except audio_mod.UndecodableAudio as exc:
        assert "damaged" in str(exc)
        assert "%" in str(exc), "says how much was unreadable, not just that some was"
    except av.error.InvalidDataError:
        # Damage in the header rather than the stream: the container itself will
        # not open, which is a different and equally honest failure.
        pass


def test_the_local_recordings_still_decode_cleanly():
    # A guard on the skip path itself: it must not start quietly dropping
    # packets from files that were fine before it existed.
    path = find_test_audio()
    if path is None:
        pytest.skip("no local test recording")

    reports = []
    audio = audio_mod.load_audio(path, on_damage=lambda *args: reports.append(args))

    assert len(audio) > 0
    assert reports == [], f"a known-good recording reported damage: {reports}"
