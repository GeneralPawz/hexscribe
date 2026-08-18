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

#: Cosine distance below which two *utterances* are the same voice.
#:
#: The first of two thresholds, and the looser one, because this pass only has
#: to avoid joining things that are obviously different -- the second pass does
#: the careful work. Raised from 0.55 after measuring a 1.31 h interview: the
#: pair-wise spread within one speaker is much wider than the spread between
#: their centroids, so a threshold calibrated on centroids fragments here.
DEFAULT_THRESHOLD = 0.60

#: Cosine distance below which two *groups* are the same person.
#:
#: The calibrated one. Measured across recordings: the same person's centroids
#: sit 0.12-0.49 apart and different people start at 0.59, so this is the
#: comparison worth trusting -- and the voice library recognises people across
#: files by exactly this measure.
#:
#: 0.50 rather than 0.55 because on the three-speaker fixture two genuinely
#: different voices sit at ~0.55, and merging them is a worse error than leaving
#: a person in two pieces: the pieces can be merged by hand, and a wrongly
#: merged pair has to be noticed first.
DEFAULT_MERGE_THRESHOLD = 0.50

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

    def embed_ranges(self, path: str | Path, ranges: list[Utterance]) -> dict:
        """One voice print from a handful of chosen utterances.

        What a correction is worth. When somebody assigns a line to a speaker the
        clustering did not recognise, that line is evidence about how the person
        sounds -- evidence nobody had when the print was made. Embedding just
        those ranges and folding them in makes the print better for next time.

        Duration-weighted like every other print here, and short clips are
        skipped for the same reason: "ja" is not evidence of anything.
        """
        samples = audio_mod.load_audio(path)
        rate = audio_mod.SAMPLE_RATE

        total = None
        seconds = 0.0
        used = 0
        for span in ranges:
            clip = samples[int(span.start * rate) : int(span.end * rate)]
            if len(clip) < int(self.min_seconds * rate):
                continue
            weight = max(0.0, span.end - span.start)
            vector = self.embed(clip) * weight
            total = vector if total is None else total + vector
            seconds += weight
            used += 1

        if total is None:
            return {"embedding": [], "seconds": 0.0, "utterances": 0}
        norm = float(np.linalg.norm(total))
        if not norm:
            return {"embedding": [], "seconds": 0.0, "utterances": 0}
        return {
            "embedding": [round(float(v), 6) for v in total / norm],
            "seconds": round(seconds, 2),
            "utterances": used,
        }

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


def cluster(vectors: np.ndarray, threshold: float, merge_threshold: float | None = None) -> list[int]:
    """Group utterance embeddings into speakers, in two passes.

    **Complete linkage first**, at a deliberately loose threshold. Merging only
    when every pair across two groups is close keeps one ambiguous utterance
    from chaining two voices together, which single linkage does immediately and
    average linkage does eventually. What it costs is fragmentation: the
    threshold is really a promise about the *worst* pair in a group, and the
    worst pair gets worse the more utterances there are. A 1.31 h interview came
    out as 45 speakers.

    **Then the centroids.** A centroid describes a voice far better than any one
    utterance of it -- measured, the same person's centroids sit 0.12-0.49 apart
    across different recordings while different people start at 0.59, which is
    the whole basis of recognising somebody in a later file. So once there are
    groups, asking whether two centroids are the same person is a better
    question than asking about their members, and it repairs what the first pass
    over-split. The same interview comes out as 11.

    Not as 2, which is what it should be. No threshold reaches 2 without also
    merging two genuinely different speakers on the three-voice fixture, whose
    centroids sit at about 0.55 -- and a wrongly merged pair has to be noticed
    before it can be fixed, while pieces of one person can simply be merged.
    That last step is a judgement only somebody who can hear the recording is
    able to make, which is what merging speakers by hand is for.
    """
    count = len(vectors)
    if count == 0:
        return []
    if count == 1:
        return [0]

    distance = 1.0 - vectors @ vectors.T
    np.fill_diagonal(distance, np.inf)

    members = [[i] for i in range(count)]
    sizes = np.ones(count)
    alive = np.ones(count, dtype=bool)

    while alive.sum() > 1:
        flat = int(np.argmin(distance))
        a, b = divmod(flat, count)
        if distance[a, b] > threshold:
            break

        # Complete linkage: the merged group's distance to everything else is
        # the *worse* of the two, which is what refuses to chain.
        merged = np.maximum(distance[a], distance[b])
        distance[a] = merged
        distance[:, a] = merged
        distance[a, a] = np.inf
        distance[b, :] = np.inf
        distance[:, b] = np.inf
        alive[b] = False
        sizes[a] += sizes[b]
        members[a] = members[a] + members[b]
        members[b] = []

    groups = [m for m in members if m]
    groups = _merge_centroids(
        vectors, groups, DEFAULT_MERGE_THRESHOLD if merge_threshold is None else merge_threshold
    )

    labels = [0] * count
    for index, group in enumerate(groups):
        for item in group:
            labels[item] = index
    return labels


def _merge_centroids(vectors: np.ndarray, groups: list[list[int]], threshold: float) -> list[list[int]]:
    """Join groups whose centroids are the same voice.

    Repeatedly, because merging two changes the centroid and can bring a third
    within reach. Closest pair first, so the most confident join happens before
    the marginal ones.
    """
    groups = [list(group) for group in groups]
    while len(groups) > 1:
        centroids = []
        for group in groups:
            total = vectors[group].sum(axis=0)
            norm = float(np.linalg.norm(total))
            centroids.append(total / norm if norm else total)
        centroids = np.array(centroids)

        between = 1.0 - centroids @ centroids.T
        np.fill_diagonal(between, np.inf)
        flat = int(np.argmin(between))
        a, b = divmod(flat, len(groups))
        if between[a, b] > threshold:
            break

        groups[a] = groups[a] + groups[b]
        groups.pop(b)

    # In the order the speakers first appear, so SPEAKER_00 is whoever talks
    # first even after the groups have been shuffled by merging.
    groups.sort(key=min)
    return groups
