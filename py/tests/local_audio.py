"""Locating the local test recording.

Real audio catches what synthetic tones cannot: resampling, a genuine mel
spectrum, a decode loop that actually terminates on speech. But the recordings
are **private**: `test/fixtures` is where they live on a machine that has them,
and every audio extension is in `.gitignore` so that none of them can be
committed by accident. So the tests take a path and assert only *structural*
properties: counts, ordering, monotonic times. Nothing asserts on the words, and
nothing prints the transcript, so a failing test cannot leak the contents into a
log.

Point `HEXSCRIBE_TEST_AUDIO` at any local recording to use your own.
"""

from __future__ import annotations

import os
from pathlib import Path

#: Where recordings live when this checkout has any. Gitignored, so a fresh
#: clone finds nothing here and the tests that need audio skip themselves.
FIXTURES = Path(__file__).resolve().parents[2] / "test" / "fixtures"

AUDIO_SUFFIXES = (".wav", ".m4a", ".mp3", ".flac", ".ogg", ".opus", ".webm", ".mp4")


def find_test_audio() -> Path | None:
    """@returns the local recording to test against, or None when unavailable."""
    override = os.environ.get("HEXSCRIBE_TEST_AUDIO")
    if override:
        candidate = Path(override)
        return candidate if candidate.exists() else None
    if FIXTURES.is_dir():
        found = sorted(p for p in FIXTURES.iterdir() if p.suffix.lower() in AUDIO_SUFFIXES)
        if found:
            return found[0]
    return None


def require_test_audio() -> Path:
    path = find_test_audio()
    if path is None:
        raise RuntimeError("no local test audio; set HEXSCRIBE_TEST_AUDIO")
    return path
