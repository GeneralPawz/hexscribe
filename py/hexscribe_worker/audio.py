"""Audio decode and Whisper log-mel features, in numpy only.

Two constraints shape this module:

- **win_arm64 wheels.** librosa / soundfile / soxr / numba have none. PyAV does,
  and it is FFmpeg, so it decodes anything and resamples to 16 kHz mono.
- **No torch.** The mel filterbank and STFT are reimplemented here rather than
  imported from transformers, whose feature extractor drags in a torch stack
  that has no PyPI wheels for this platform. The implementation mirrors
  `transformers.audio_utils` (slaney mel scale, slaney norm, periodic Hann,
  centered reflect-padded STFT) so features match what the model was
  quantized against; `tests/test_mel.py` pins it against OpenAI's own filters.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
N_FFT = 400
HOP_LENGTH = 160
N_MELS = 80
CHUNK_SECONDS = 30
CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_SECONDS  # 480_000
N_FRAMES = CHUNK_SAMPLES // HOP_LENGTH  # 3000


#: How much of a file may fail to decode before it is a broken file rather than a
#: blemished one. Real recordings routinely end in a truncated frame -- a 1.31 h
#: MP3 from a voice recorder had exactly one bad packet in 196,800, the last one
#: -- and losing an hour of interview over a fraction of a second is the wrong
#: trade. Losing a tenth of the file silently would be the wrong trade too.
MAX_BAD_PACKET_RATIO = 0.02


class UndecodableAudio(ValueError):
    """The file is damaged beyond the point where skipping is honest."""


def load_audio(path: str | Path, *, on_damage=None) -> np.ndarray:
    """Decode any container to float32 mono at 16 kHz.

    Decodes packet by packet rather than in one pass, so a corrupt packet is
    skipped instead of ending the file. `container.decode()` raises on the first
    bad one, which meant a single truncated frame in the last seconds of a
    recording threw away everything before it -- the failure that prompted this.

    Skipping is not silent: `on_damage(skipped, total)` is called when anything
    was dropped, and past `MAX_BAD_PACKET_RATIO` the file is refused outright.
    A transcript with an unannounced hole in it is worse than an error.
    """
    import av

    container = av.open(str(path))
    try:
        streams = [s for s in container.streams if s.type == "audio"]
        if not streams:
            raise ValueError(f"no audio stream in {path}")
        resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)
        chunks: list[np.ndarray] = []
        packets = 0
        skipped = 0

        for packet in container.demux(streams[0]):
            packets += 1
            try:
                frames = list(packet.decode())
            except av.error.InvalidDataError:
                # One damaged packet. FFmpeg's own tools log this and continue.
                skipped += 1
                continue
            for frame in frames:
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray()[0])

        for out in resampler.resample(None):  # flush
            chunks.append(out.to_ndarray()[0])
    finally:
        container.close()

    if skipped and packets and skipped / packets > MAX_BAD_PACKET_RATIO:
        raise UndecodableAudio(
            f"{skipped} of {packets} audio packets could not be decoded "
            f"({skipped / packets:.1%}). The file looks damaged rather than "
            f"merely blemished; re-export it and try again."
        )
    if skipped and on_damage:
        on_damage(skipped, packets)

    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32, copy=False)


# --- mel filterbank (slaney scale + slaney norm, as librosa/whisper use) ---


def _hz_to_mel(freq: np.ndarray | float) -> np.ndarray:
    f_sp = 200.0 / 3
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    freq = np.asarray(freq, dtype=np.float64)
    return np.where(
        freq >= min_log_hz,
        min_log_mel + np.log(np.maximum(freq, 1e-10) / min_log_hz) / logstep,
        freq / f_sp,
    )


def _mel_to_hz(mels: np.ndarray) -> np.ndarray:
    f_sp = 200.0 / 3
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    mels = np.asarray(mels, dtype=np.float64)
    return np.where(
        mels >= min_log_mel,
        min_log_hz * np.exp(logstep * (mels - min_log_mel)),
        f_sp * mels,
    )


def mel_filters(n_mels: int = N_MELS, n_fft: int = N_FFT, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Return the (n_mels, n_freq_bins) filterbank matrix."""
    n_freqs = n_fft // 2 + 1
    fft_freqs = np.linspace(0.0, sample_rate / 2.0, n_freqs)
    mel_min, mel_max = _hz_to_mel(0.0), _hz_to_mel(sample_rate / 2.0)
    filter_freqs = _mel_to_hz(np.linspace(mel_min, mel_max, n_mels + 2))

    filter_diff = np.diff(filter_freqs)
    slopes = filter_freqs[np.newaxis, :] - fft_freqs[:, np.newaxis]
    down = -slopes[:, :-2] / filter_diff[:-1]
    up = slopes[:, 2:] / filter_diff[1:]
    bank = np.maximum(0.0, np.minimum(down, up))

    # Slaney normalization: equal area per filter.
    enorm = 2.0 / (filter_freqs[2 : n_mels + 2] - filter_freqs[:n_mels])
    bank *= enorm[np.newaxis, :]
    return bank.T.astype(np.float32)  # (n_mels, n_freqs)


_FILTERS: np.ndarray | None = None


def _filters() -> np.ndarray:
    global _FILTERS
    if _FILTERS is None:
        _FILTERS = mel_filters()
    return _FILTERS


def log_mel_spectrogram(audio: np.ndarray) -> np.ndarray:
    """Whisper log-mel features, shape (N_MELS, N_FRAMES), for one 30 s chunk.

    Audio shorter than 30 s is zero-padded; longer audio is truncated. Chunking
    is the caller's job.
    """
    if audio.shape[0] < CHUNK_SAMPLES:
        audio = np.pad(audio, (0, CHUNK_SAMPLES - audio.shape[0]))
    else:
        audio = audio[:CHUNK_SAMPLES]

    # Centered STFT: reflect-pad by n_fft // 2, then frame.
    pad = N_FFT // 2
    padded = np.pad(audio.astype(np.float32), (pad, pad), mode="reflect")
    n_frames = 1 + (padded.shape[0] - N_FFT) // HOP_LENGTH  # 3001
    frames = np.lib.stride_tricks.as_strided(
        padded,
        shape=(n_frames, N_FFT),
        strides=(padded.strides[0] * HOP_LENGTH, padded.strides[0]),
    )
    window = np.hanning(N_FFT + 1)[:-1].astype(np.float32)  # periodic
    spectrum = np.fft.rfft(frames * window, n=N_FFT, axis=-1)
    magnitudes = (np.abs(spectrum) ** 2).T[:, :-1]  # (n_freqs, 3000)

    mel_spec = _filters() @ magnitudes
    log_spec = np.log10(np.maximum(mel_spec, 1e-10))
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    return ((log_spec + 4.0) / 4.0).astype(np.float32)


def chunk_audio(audio: np.ndarray, chunk_samples: int = CHUNK_SAMPLES) -> list[np.ndarray]:
    """Split into fixed 30 s chunks; the tail keeps whatever is left."""
    if audio.shape[0] == 0:
        return []
    return [audio[i : i + chunk_samples] for i in range(0, audio.shape[0], chunk_samples)]
