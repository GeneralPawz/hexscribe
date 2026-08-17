"""Speaker diarization that starts from the utterances, not from the audio.

The other diarizer (`diarize.py`) is the textbook pipeline: pyannote segments the
audio into speech regions, an embedding network turns each region into a vector,
and clustering groups the vectors. It has one structural problem for this app --
its regions are cut on its own criteria, and where a region spans a speaker
change the embedding lands halfway between two voices and takes the clustering
with it.

But we are not asking "who spoke when". We are asking "who said this utterance",
and by the time diarization runs we already have utterances, cut by Whisper on
the speech it actually heard. So this diarizer embeds those and clusters them.

Measured on `test/fixtures`, the difference is not marginal:

    pyannote regions   one-speaker file: 2 speakers at threshold 0.5 (wrong)
                       three-speaker file: 1 speaker at every threshold (wrong)
    utterances         one-speaker file: 1 speaker from 0.40 to 0.70
                       three-speaker file: 3 speakers from 0.45 to 0.70, matching
                       the oracle line for line

The three-speaker recording is the harder case in every way -- one voice is
whispered ~30 dB below the rest, which pyannote drops as non-speech entirely, and
one speaker says a single word. Both land correctly here because Whisper heard
them and cut around them.

It is also far cheaper. There is no segmentation pass at all: the cost is one
embedding per utterance, a few tens of milliseconds each, against a diarization
that used to cost several times the transcription.

What it gives up is real and worth naming: a speaker change *inside* one
utterance is invisible here, and overlapping speech cannot be represented. The
old path is still available for that (`diarize-sherpa`), and neither could be
used by the consumer anyway -- attribution has always collapsed a turn to one
speaker per utterance.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import audio as audio_mod
from .diarize import DEFAULT_THREADS, DiarizationUnavailable, Turn, _label

#: Cosine distance below which two utterances are the same voice.
#:
#: Measured on the fixtures: within-speaker distances top out at 0.49 (one
#: speaker's whispered line against her own normal voice) and between-speaker
#: distances start at 0.59, so anything in that gap works. 0.55 sits in the
#: middle of it rather than at either edge.
DEFAULT_THRESHOLD = 0.55

#: Below this, an utterance is too short to embed reliably and is left
#: unlabelled rather than guessed at. A speaker embedding wants a second or two
#: of voice; "Ja." is not evidence of anything.
MIN_SECONDS = 0.4


@dataclass
class Utterance:
    start: float
    end: float


class UtteranceDiarizer:
    """Embeds each utterance and clusters the embeddings."""

    def __init__(
        self,
        embedding_model: str | Path,
        *,
        threads: int = DEFAULT_THREADS,
        threshold: float = DEFAULT_THRESHOLD,
        min_seconds: float = MIN_SECONDS,
    ) -> None:
        self.embedding_model = Path(embedding_model)
        self.threads = threads
        self.threshold = threshold
        self.min_seconds = min_seconds
        self._extractor = None

    def available(self) -> bool:
        try:
            import sherpa_onnx  # noqa: F401
        except ImportError:
            return False
        return self.embedding_model.exists()

    def _extract(self):
        if self._extractor is not None:
            return self._extractor
        try:
            import sherpa_onnx
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise DiarizationUnavailable(
                "sherpa-onnx is not installed. Run `uv sync` in py/ to add it."
            ) from exc
        if not self.embedding_model.exists():
            raise DiarizationUnavailable(
                f"missing speaker embedding model: {self.embedding_model}. "
                "Run scripts/fetch-models.ps1."
            )
        self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(self.embedding_model), num_threads=self.threads
            )
        )
        return self._extractor

    def embed(self, clip: np.ndarray) -> np.ndarray:
        """One L2-normalised speaker vector, so a dot product is a cosine."""
        extractor = self._extract()
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=audio_mod.SAMPLE_RATE, waveform=clip)
        stream.input_finished()
        vector = np.asarray(extractor.compute(stream), dtype=np.float64)
        norm = float(np.linalg.norm(vector))
        return vector / norm if norm else vector

    def diarize(
        self,
        path: str | Path,
        utterances: list[Utterance],
        *,
        threshold: float | None = None,
    ) -> tuple[list[Turn], dict, list[dict]]:
        samples = audio_mod.load_audio(path)
        return self.diarize_samples(samples, utterances, threshold=threshold)

    def diarize_samples(
        self,
        samples: np.ndarray,
        utterances: list[Utterance],
        *,
        threshold: float | None = None,
    ) -> tuple[list[Turn], dict, list[dict]]:
        cut = self.threshold if threshold is None else threshold
        started = time.perf_counter()
        rate = audio_mod.SAMPLE_RATE

        vectors: list[np.ndarray] = []
        embedded: list[Utterance] = []
        skipped = 0
        for utterance in utterances:
            clip = samples[int(utterance.start * rate) : int(utterance.end * rate)]
            if len(clip) < int(self.min_seconds * rate):
                skipped += 1
                continue
            vectors.append(self.embed(clip))
            embedded.append(utterance)

        labels = cluster(np.array(vectors), cut) if vectors else []

        # Renumber by first appearance, so SPEAKER_00 is whoever talks first.
        order: dict[int, str] = {}
        turns: list[Turn] = []
        for label, utterance in zip(labels, embedded):
            if label not in order:
                order[label] = _label(len(order))
            turns.append(Turn(start=utterance.start, end=utterance.end, speaker=order[label]))

        profiles = _profiles(labels, vectors, embedded, order)

        elapsed_ms = (time.perf_counter() - started) * 1000
        audio_seconds = len(samples) / rate
        timing = {
            "audio_seconds": round(audio_seconds, 3),
            "total_ms": round(elapsed_ms, 1),
            "rtf": round(elapsed_ms / 1000 / audio_seconds, 4) if audio_seconds else 0.0,
            "turns": len(turns),
            "speakers": len(order),
            "too_short": skipped,
        }
        return turns, timing, profiles


def _profiles(
    labels: list[int],
    vectors: list[np.ndarray],
    utterances: list[Utterance],
    order: dict[int, str],
) -> list[dict]:
    """One voice print per speaker, for recognising them in another recording.

    The mean of a speaker's utterance vectors, renormalised — a centroid, which
    is a better description of a voice than any single utterance of it, because
    the things that vary between utterances (loudness, emphasis, how much of the
    clip is silence) average out while the voice does not.

    Weighted by duration on purpose: a four-second sentence is more evidence of
    what someone sounds like than a one-second interjection, and treating them
    equally lets a clipped "ja" pull the centroid around.
    """
    totals: dict[int, np.ndarray] = {}
    weights: dict[int, float] = {}
    counts: dict[int, int] = {}
    for label, vector, utterance in zip(labels, vectors, utterances):
        seconds = max(0.0, utterance.end - utterance.start)
        totals[label] = totals.get(label, 0.0) + vector * seconds
        weights[label] = weights.get(label, 0.0) + seconds
        counts[label] = counts.get(label, 0) + 1

    profiles = []
    for label, name in order.items():
        centroid = totals[label]
        norm = float(np.linalg.norm(centroid))
        if not norm:
            continue
        profiles.append(
            {
                "speaker": name,
                "embedding": [round(float(value), 6) for value in centroid / norm],
                "seconds": round(weights[label], 2),
                "utterances": counts[label],
            }
        )
    return profiles


def cluster(vectors: np.ndarray, threshold: float) -> list[int]:
    """Agglomerative clustering with complete linkage.

    Complete linkage, not average or single: it merges two groups only when
    *every* pair across them is close enough. Single linkage would chain two
    voices together through one ambiguous utterance sitting between them, which
    is exactly the failure this module exists to avoid.

    The stopping rule is the threshold, not a cluster count: the number of
    speakers is what we are trying to find out.
    """
    count = len(vectors)
    if count == 0:
        return []
    if count == 1:
        return [0]

    distance = 1.0 - vectors @ vectors.T
    np.fill_diagonal(distance, np.inf)

    members = [[i] for i in range(count)]
    alive = np.ones(count, dtype=bool)

    while alive.sum() > 1:
        flat = int(np.argmin(distance))
        a, b = divmod(flat, count)
        if distance[a, b] > threshold:
            break

        # Complete linkage: the merged cluster's distance to everything else is
        # the *worse* of the two, which is what makes the guarantee above hold.
        merged = np.maximum(distance[a], distance[b])
        distance[a] = merged
        distance[:, a] = merged
        distance[a, a] = np.inf
        distance[b, :] = np.inf
        distance[:, b] = np.inf
        alive[b] = False
        members[a] = members[a] + members[b]
        members[b] = []

    labels = [0] * count
    for index, group in enumerate(m for m in members if m):
        for item in group:
            labels[item] = index
    return labels
