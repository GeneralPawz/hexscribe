"""Speaker diarization: who spoke when.

Three ONNX models behind one call, via sherpa-onnx: pyannote segmentation-3.0
finds speech regions and overlaps, a speaker-embedding network turns each region
into a vector, and clustering groups the vectors into speakers.

Two notes on the environment, both load-bearing:

- **It runs on the CPU.** Neither model has a precompiled QAIRT context binary,
  and the NPU path needs one. Diarization therefore costs several times what
  transcription does (~0.3 RTF at four threads, against ~0.05 for Whisper on the
  NPU), which is why every caller treats it as opt-in.
- **sherpa-onnx bundles its own ONNX Runtime**, loaded into the same process as
  our QNN one. That is exactly the situation that breaks quietly, so
  `spikes/05_diarize_probe.py` exercises a QNN session *after* diarization; the
  two coexist on this build. If a future version stops coexisting, the fix is a
  second worker process, not a rewrite: this module holds no other state.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import audio as audio_mod

#: Four threads measured fastest on a 10-core Snapdragon X Plus: one thread took
#: 89 s for 191 s of audio, four took 57 s, eight took 173 s (oversubscription).
DEFAULT_THREADS = 4

#: Cosine-distance threshold at which two voices are still the same person.
#: Lower splits more eagerly. 0.5 found four speakers in a four-person
#: conversation and is sherpa-onnx's own default.
#:
#: This is the *only* speaker-count control, deliberately. sherpa's
#: `num_clusters` looks like the obvious way to pin an exact count, and it does
#: cut the dendrogram into that many clusters -- but complete linkage splits off
#: tiny outlier clusters, and the frame-level label finalisation downstream then
#: drops them, so the count that comes out is not the count that went in.
#: Measured on a 190 s recording: asking for 2 or 3 returned 1 speaker, asking
#: for 4 returned 2, while threshold clustering returned a well-formed 4.
DEFAULT_THRESHOLD = 0.5


class DiarizationUnavailable(RuntimeError):
    """sherpa-onnx or its models are missing."""


@dataclass
class Turn:
    start: float
    end: float
    speaker: str

    def as_dict(self) -> dict:
        return {"start": round(self.start, 3), "end": round(self.end, 3), "speaker": self.speaker}


def _label(index: int) -> str:
    return f"SPEAKER_{index:02d}"


class Diarizer:
    """Loads the models once, then answers `diarize()` calls."""

    def __init__(
        self,
        segmentation_model: str | Path,
        embedding_model: str | Path,
        *,
        threads: int = DEFAULT_THREADS,
        threshold: float = DEFAULT_THRESHOLD,
        min_duration_on: float = 0.3,
        min_duration_off: float = 0.5,
    ) -> None:
        self.segmentation_model = Path(segmentation_model)
        self.embedding_model = Path(embedding_model)
        self.threads = threads
        self.threshold = threshold
        self.min_duration_on = min_duration_on
        self.min_duration_off = min_duration_off
        self._engines: dict[int, object] = {}

    def available(self) -> bool:
        try:
            import sherpa_onnx  # noqa: F401
        except ImportError:
            return False
        return self.segmentation_model.exists() and self.embedding_model.exists()

    def _engine(self, threshold: float):
        """One engine per threshold; sherpa fixes clustering at construction."""
        if threshold in self._engines:
            return self._engines[threshold]
        try:
            import sherpa_onnx
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise DiarizationUnavailable(
                "sherpa-onnx is not installed. Run `uv sync` in py/ to add it."
            ) from exc

        for path in (self.segmentation_model, self.embedding_model):
            if not path.exists():
                raise DiarizationUnavailable(
                    f"missing diarization model: {path}. Run scripts/fetch-models.ps1."
                )

        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=str(self.segmentation_model)
                ),
                num_threads=self.threads,
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(self.embedding_model), num_threads=self.threads
            ),
            # num_clusters is left unset on purpose -- see DEFAULT_THRESHOLD.
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=threshold),
            min_duration_on=self.min_duration_on,
            min_duration_off=self.min_duration_off,
        )
        if not config.validate():
            raise DiarizationUnavailable("sherpa-onnx rejected the diarization configuration")

        engine = sherpa_onnx.OfflineSpeakerDiarization(config)
        self._engines[threshold] = engine
        return engine

    def diarize(self, path: str | Path, *, threshold: float | None = None) -> tuple[list[Turn], dict]:
        """@returns the speaker turns in time order, plus timing information."""
        samples = audio_mod.load_audio(path)
        return self.diarize_samples(samples, threshold=threshold)

    def diarize_samples(
        self, samples: np.ndarray, *, threshold: float | None = None
    ) -> tuple[list[Turn], dict]:
        engine = self._engine(self.threshold if threshold is None else threshold)

        started = time.perf_counter()
        result = engine.process(samples).sort_by_start_time()
        elapsed_ms = (time.perf_counter() - started) * 1000

        # sherpa's cluster ids are arbitrary and can have gaps ([0, 1, 3, 5]).
        # Renumber by first appearance so SPEAKER_00 is whoever talks first.
        order: dict[int, str] = {}
        turns: list[Turn] = []
        for segment in result:
            if segment.speaker not in order:
                order[segment.speaker] = _label(len(order))
            turns.append(Turn(start=segment.start, end=segment.end, speaker=order[segment.speaker]))

        audio_seconds = len(samples) / audio_mod.SAMPLE_RATE
        timing = {
            "audio_seconds": round(audio_seconds, 3),
            "total_ms": round(elapsed_ms, 1),
            "rtf": round(elapsed_ms / 1000 / audio_seconds, 4) if audio_seconds else 0.0,
            "turns": len(turns),
            "speakers": len(order),
        }
        return turns, timing
