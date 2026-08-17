"""Whisper on the Hexagon NPU via precompiled QAIRT context binaries.

The asset (qai-hub `whisper_*_quantized`, target runtime `precompiled_qnn_onnx`)
is two fixed-shape graphs whose tensors are quantized, so this engine owns the
quantization boundary that a float ONNX export would hide:

    audio -> log-mel (float) -> quantize u16 -> ENCODER -> cross KV (u8, stays quantized)
    token -> DECODER (u8 self-KV ring, u16 mask) -> logits (u16, argmax needs no dequant)

Shapes are fixed by the context binary: 30 s of audio (80 x 3000 mel frames) and
a 200-token decode window. Everything variable -- language, chunking, stopping --
lives in this file, not in the graph.

`metadata.json` beside the graphs carries every scale/zero-point, so nothing here
is a hardcoded quantization constant.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import audio as audio_mod
from .qnn import npu_session

# Whisper's masked-attention fill, per qai-hub's reference implementation.
MASK_NEG = -100.0


@dataclass
class Timing:
    """Per-transcription instrumentation. RTF < 1 means faster than real time."""

    audio_seconds: float = 0.0
    encode_ms: float = 0.0
    decode_ms: float = 0.0
    feature_ms: float = 0.0
    tokens: int = 0
    chunks: int = 0

    @property
    def total_ms(self) -> float:
        return self.feature_ms + self.encode_ms + self.decode_ms

    @property
    def rtf(self) -> float:
        return (self.total_ms / 1000.0) / self.audio_seconds if self.audio_seconds else 0.0

    @property
    def ms_per_token(self) -> float:
        return self.decode_ms / self.tokens if self.tokens else 0.0

    def as_dict(self) -> dict:
        return {
            "audio_seconds": round(self.audio_seconds, 3),
            "feature_ms": round(self.feature_ms, 1),
            "encode_ms": round(self.encode_ms, 1),
            "decode_ms": round(self.decode_ms, 1),
            "total_ms": round(self.total_ms, 1),
            "rtf": round(self.rtf, 4),
            "tokens": self.tokens,
            "ms_per_token": round(self.ms_per_token, 2),
            "chunks": self.chunks,
        }


@dataclass
class Segment:
    """One decoded 30 s window."""

    index: int
    start: float
    end: float
    text: str
    tokens: list[int] = field(default_factory=list)


def _quantize(x: np.ndarray, scale: float, zero_point: int, dtype: type[np.unsignedinteger]) -> np.ndarray:
    info = np.iinfo(dtype)
    q = np.rint(x / scale) + zero_point
    return np.clip(q, info.min, info.max).astype(dtype)


class _Buffers:
    """Pre-allocated, re-bound tensors for one engine's encode/decode cycle.

    Without binding, every decoder step hands ORT 51 fresh numpy inputs and gets
    25 freshly allocated outputs back -- including the 24 cross-attention KV
    tensors (~28 MB) that do not change for the whole 30 s window, and the self
    KV ring that is copied out of ORT only to be copied straight back in.

    Everything here is allocated once per engine and reused:

    - cross KV: written by the encoder directly into these buffers, then bound as
      decoder inputs. No numpy round trip between the two graphs at all.
    - self KV: two banks, ping-ponged. Step N reads bank A and writes bank B;
      step N+1 swaps. The feedback path becomes a rebind, not a copy.
    - ids / mask / position: updated in place.

    The QNN EP still stages its own device copies -- ORT's Python API exposes no
    NPU allocator, only CPU OrtValues -- so this removes the Python-side
    allocation and copies, not the EP-internal ones.
    """

    def __init__(self, engine: "WhisperQnn") -> None:
        import onnxruntime as ort

        self._ort = ort
        dec_in = engine._dec_spec["inputs"]
        dec_out = engine._dec_spec["outputs"]

        def empty(spec: dict) -> "ort.OrtValue":
            # Takes a numpy dtype, not an ONNX type string.
            return ort.OrtValue.ortvalue_from_shape_and_type(tuple(spec["shape"]), np.dtype(spec["dtype"]))

        # Cross KV: encoder outputs and decoder inputs share one set of buffers.
        self.cross = {name: empty(engine._enc_spec["outputs"][name]) for name in engine._cross_names}

        # Self KV: two banks of the same shapes, swapped every step.
        self.self_banks = [{name: empty(dec_in[name]) for name in engine._self_in} for _ in range(2)]
        # Quantized zero, i.e. what an empty cache position means.
        self._self_zero = {
            name: np.full(tuple(dec_in[name]["shape"]), int(dec_in[name]["quantization_parameters"]["zero_point"]), dtype=np.uint8)
            for name in engine._self_in
        }

        self.ids_np = np.zeros((1, 1), dtype=np.int32)
        self.position_np = np.zeros(1, dtype=np.int32)
        self.mask_np = np.full((1, 1, 1, engine.decode_window), engine._mask_ignore, dtype=np.uint16)
        self.ids = ort.OrtValue.ortvalue_from_numpy(self.ids_np)
        self.position = ort.OrtValue.ortvalue_from_numpy(self.position_np)
        self.mask = ort.OrtValue.ortvalue_from_numpy(self.mask_np)
        self.logits = empty(dec_out["logits"])

        self.features_np = np.zeros(tuple(engine._enc_spec["inputs"]["input_features"]["shape"]), dtype=np.uint16)
        self.features = ort.OrtValue.ortvalue_from_numpy(self.features_np)

        self.encoder_binding = engine.encoder.io_binding()
        self.encoder_binding.bind_ortvalue_input("input_features", self.features)
        for name, value in self.cross.items():
            self.encoder_binding.bind_ortvalue_output(name, value)

        self.decoder_binding = engine.decoder.io_binding()
        for name, value in self.cross.items():
            self.decoder_binding.bind_ortvalue_input(name, value)
        self.decoder_binding.bind_ortvalue_input("input_ids", self.ids)
        self.decoder_binding.bind_ortvalue_input("position_ids", self.position)
        self.decoder_binding.bind_ortvalue_input("attention_mask", self.mask)
        self.decoder_binding.bind_ortvalue_output("logits", self.logits)

        self._engine = engine
        self._read = 0

    def reset_for_chunk(self, mask_ignore: np.uint16) -> None:
        """Clear the self-attention ring and the mask before a new window."""
        for bank in self.self_banks:
            for name, value in bank.items():
                value.update_inplace(self._self_zero[name])
        self.mask_np.fill(mask_ignore)
        self.mask.update_inplace(self.mask_np)
        self._read = 0

    def bind_step(self) -> None:
        """Point the decoder at the current read bank, writing into the other."""
        read, write = self.self_banks[self._read], self.self_banks[1 - self._read]
        for out_name in self._engine._self_out:
            in_name = self._engine._self_out_to_in[out_name]
            self.decoder_binding.bind_ortvalue_input(in_name, read[in_name])
            self.decoder_binding.bind_ortvalue_output(out_name, write[in_name])

    def swap(self) -> None:
        self._read = 1 - self._read


class WhisperQnn:
    """Loads the two context binaries and runs greedy decoding on the NPU."""

    def __init__(
        self,
        model_dir: str | Path,
        tokenizer_path: str | Path,
        *,
        io_binding: bool = True,
        no_speech_threshold: float = 0.6,
    ) -> None:
        self.io_binding = io_binding
        #: Windows whose no-speech probability exceeds this are skipped entirely.
        self.no_speech_threshold = no_speech_threshold
        self._buffers: _Buffers | None = None
        self.model_dir = Path(model_dir)
        meta = json.loads((self.model_dir / "metadata.json").read_text(encoding="utf-8"))
        self.meta = meta
        self.model_name: str = meta.get("model_name", self.model_dir.name)

        enc_spec = meta["model_files"]["encoder.onnx"]
        dec_spec = meta["model_files"]["decoder.onnx"]
        self._enc_spec, self._dec_spec = enc_spec, dec_spec

        feat_q = enc_spec["inputs"]["input_features"]["quantization_parameters"]
        self._feat_scale = feat_q["scale"]
        self._feat_zp = int(feat_q["zero_point"])

        mask_spec = dec_spec["inputs"]["attention_mask"]
        self.decode_window = int(mask_spec["shape"][-1])  # 200
        mask_q = mask_spec["quantization_parameters"]
        self._mask_attend = np.uint16(int(mask_q["zero_point"]))  # 0.0 attends
        self._mask_ignore = _quantize(np.array([MASK_NEG]), mask_q["scale"], int(mask_q["zero_point"]), np.uint16)[0]

        self.encoder = npu_session(self.model_dir / "encoder.onnx")
        self.decoder = npu_session(self.model_dir / "decoder.onnx")

        self._cross_names = [o.name for o in self.encoder.get_outputs()]
        self._self_in = [n for n in dec_spec["inputs"] if n.endswith("_in")]
        self._self_out = [n for n in dec_spec["outputs"] if n.endswith("_out")]
        self._self_out_to_in = {o: o[: -len("_out")] + "_in" for o in self._self_out}

        from tokenizers import Tokenizer

        self.tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self.sot = self._token("<|startoftranscript|>")
        self.eot = self._token("<|endoftext|>")
        self.no_timestamps = self._token("<|notimestamps|>")
        self.transcribe_token = self._token("<|transcribe|>")
        self.translate_token = self._token("<|translate|>")
        # Everything at or above <|endoftext|> is a control token, not text.
        self._first_special = self.eot
        # Timestamp tokens are the tail of the vocabulary: <|0.00|> .. <|30.00|>
        # in 0.02 s steps, so a token id maps to a time by subtraction.
        self.timestamp_begin = self._token("<|0.00|>")
        self.timestamp_step = 0.02
        # Whisper's default: the first utterance may not start later than 1 s in.
        self._max_initial_timestamp = int(1.0 / self.timestamp_step)

        logit_q = dec_spec["outputs"]["logits"]["quantization_parameters"]
        self._logit_scale = float(logit_q["scale"])
        self._logit_zp = int(logit_q["zero_point"])

        # Whisper's no-speech token (spelled <|nocaptions|> in this vocabulary).
        # Its probability at the very first decode position is how Whisper knows
        # a window is silence -- which matters because the model does not stay
        # quiet on silence, it hallucinates plausible sentences.
        self.no_speech_token = self.tokenizer.token_to_id("<|nocaptions|>") or self.tokenizer.token_to_id(
            "<|nospeech|>"
        )
        #: Probability that the last decoded window contained no speech.
        self.last_no_speech = 0.0

    def _token(self, text: str) -> int:
        tid = self.tokenizer.token_to_id(text)
        if tid is None:
            raise ValueError(f"tokenizer has no token {text!r}")
        return tid

    def _record_no_speech(self, raw_logits: np.ndarray) -> None:
        """Read p(no speech) from the distribution predicted right after `<|sot|>`."""
        if self.no_speech_token is None:
            return
        logits = (raw_logits.astype(np.float32) - self._logit_zp) * self._logit_scale
        logits -= logits.max()
        exp = np.exp(logits)
        self.last_no_speech = float(exp[self.no_speech_token] / exp.sum())

    def _next_token(self, raw_logits: np.ndarray, generated: list[int], timestamps: bool) -> int:
        """Greedy pick, with Whisper's timestamp rules when timestamps are wanted.

        Plain argmax cannot produce timestamps: the model spreads its confidence
        across 1501 timestamp tokens, so any single one loses to the best text
        token even when a boundary is clearly due -- the model emits `<|0.00|>`
        and then never another. OpenAI's decoder fixes this with rules that this
        method reproduces (openai/whisper `decoding.py: ApplyTimestampRules`):

        1. timestamps come in pairs, so a lone timestamp must be followed by text
           and a closing timestamp must be followed by a timestamp;
        2. timestamps never move backwards;
        3. the first sampled token must be a timestamp, within `max_initial`;
        4. **the aggregate rule**: if the summed probability of *all* timestamps
           beats the best single text token, force a timestamp.

        Rule 4 is the one that matters, and it needs real probabilities, so the
        logits are dequantized here. The softmax normalizer cancels on both sides
        of the comparison, which is why only a 1501-wide logsumexp is computed
        rather than a full log-softmax over 51,865 classes.
        """
        if not timestamps:
            # Affine dequantization is monotonic, so argmax needs no dequant.
            return int(np.argmax(raw_logits))

        tb = self.timestamp_begin
        logits = (raw_logits.astype(np.float32) - self._logit_zp) * self._logit_scale
        logits[self.no_timestamps] = -np.inf

        last = generated[-1] if generated else None
        last_was_ts = last is not None and last >= tb
        penultimate_was_ts = len(generated) < 2 or generated[-2] >= tb

        if last_was_ts:
            if penultimate_was_ts:
                logits[tb:] = -np.inf  # closing timestamp: text must follow
            else:
                logits[: self.eot] = -np.inf  # opening timestamp: pair it

        seen = [t for t in generated if t >= tb]
        if seen:
            # Never go backwards; a closed pair may repeat its own value.
            last_allowed = seen[-1] if (last_was_ts and not penultimate_was_ts) else seen[-1] + 1
            logits[tb:last_allowed] = -np.inf

        if not generated:
            logits[:tb] = -np.inf  # the first sampled token is a timestamp
            logits[tb + self._max_initial_timestamp + 1 :] = -np.inf

        finite = logits[tb:]
        peak = finite.max()
        if np.isfinite(peak):
            timestamp_logprob = peak + np.log(np.exp(finite - peak).sum())
            text_max = logits[:tb].max()
            if timestamp_logprob > text_max:
                logits[:tb] = -np.inf

        return int(np.argmax(logits))

    def language_token(self, language: str) -> int:
        return self._token(f"<|{language.lower()}|>")

    # --- inference -------------------------------------------------------

    def _initial_self_cache(self) -> dict[str, np.ndarray]:
        """Self-attention KV ring, pre-filled with the quantized value of 0.0."""
        cache: dict[str, np.ndarray] = {}
        for name in self._self_in:
            spec = self._dec_spec["inputs"][name]
            zp = int(spec["quantization_parameters"]["zero_point"])
            cache[name] = np.full(tuple(spec["shape"]), zp, dtype=np.uint8)
        return cache

    def _prompt(self, language: str | None, task: str, timestamps: bool) -> list[int]:
        if language is None:
            # Let the model predict the language token itself.
            return [self.sot]
        task_token = self.translate_token if task == "translate" else self.transcribe_token
        prompt = [self.sot, self.language_token(language), task_token]
        if not timestamps:
            prompt.append(self.no_timestamps)
        return prompt

    def parse_segments(
        self, tokens: list[int], offset: float, chunk_end: float
    ) -> tuple[list[Segment], float | None]:
        """Split a token sequence into utterances at its timestamp tokens.

        Whisper brackets each utterance with timestamps -- `<|0.00|> text <|2.34|>`
        -- and the next one opens on the same value it closed on. A run that ends
        without its closing timestamp (the decode window filled up mid-sentence)
        is still emitted, ending at the chunk boundary.
        """
        segments: list[Segment] = []
        start: float | None = None
        current: list[int] = []
        last_closed: float | None = None

        def flush(end: float) -> None:
            text = self.decode_text(current)
            if text:
                segments.append(
                    Segment(
                        index=len(segments),
                        start=offset + (start or 0.0),
                        end=min(offset + end, chunk_end),
                        text=text,
                        tokens=list(current),
                    )
                )
            current.clear()

        for token in tokens:
            if token >= self.timestamp_begin:
                when = (token - self.timestamp_begin) * self.timestamp_step
                if start is None:
                    start = when
                else:
                    flush(when)
                    last_closed = when
                    start = None
            elif token < self._first_special:
                current.append(token)

        if current:
            # Dangling text: the window filled up mid-utterance. Emitted so the
            # words are not lost, but `last_closed` stays where it was so a
            # caller can re-decode this part with more audio ahead of it.
            flush(chunk_end - offset)
        return segments, last_closed

    @property
    def buffers(self) -> _Buffers:
        if self._buffers is None:
            self._buffers = _Buffers(self)
        return self._buffers

    def transcribe_chunk(
        self,
        chunk: np.ndarray,
        *,
        language: str | None = None,
        task: str = "transcribe",
        timestamps: bool = True,
        timing: Timing | None = None,
    ) -> list[int]:
        if self.io_binding:
            return self._transcribe_chunk_bound(chunk, language, task, timestamps, timing or Timing())
        return self._transcribe_chunk_plain(chunk, language, task, timestamps, timing or Timing())

    def _features(self, chunk: np.ndarray, timing: Timing, out: np.ndarray | None = None) -> np.ndarray:
        t0 = time.perf_counter()
        mel = audio_mod.log_mel_spectrogram(chunk)
        features = _quantize(mel[np.newaxis, :, :], self._feat_scale, self._feat_zp, np.uint16)
        if out is not None:
            out[...] = features
            features = out
        timing.feature_ms += (time.perf_counter() - t0) * 1000
        return features

    def _transcribe_chunk_bound(
        self, chunk: np.ndarray, language: str | None, task: str, timestamps: bool, timing: Timing
    ) -> list[int]:
        buffers = self.buffers
        self._features(chunk, timing, out=buffers.features_np)
        buffers.features.update_inplace(buffers.features_np)

        t0 = time.perf_counter()
        # Cross KV lands directly in the buffers the decoder already reads.
        self.encoder.run_with_iobinding(buffers.encoder_binding)
        timing.encode_ms += (time.perf_counter() - t0) * 1000

        prompt = self._prompt(language, task, timestamps)
        tokens = list(prompt)
        buffers.reset_for_chunk(self._mask_ignore)

        t0 = time.perf_counter()
        for step in range(self.decode_window - 1):
            # The window is right-aligned: step n attends to the newest n+1 slots.
            buffers.mask_np[0, 0, 0, self.decode_window - step - 1] = self._mask_attend
            buffers.mask.update_inplace(buffers.mask_np)
            buffers.ids_np[0, 0] = tokens[step]
            buffers.ids.update_inplace(buffers.ids_np)
            buffers.position_np[0] = step
            buffers.position.update_inplace(buffers.position_np)

            buffers.bind_step()
            self.decoder.run_with_iobinding(buffers.decoder_binding)
            buffers.swap()

            raw = buffers.logits.numpy().reshape(-1)
            if step == 0:
                self._record_no_speech(raw)
            next_token = self._next_token(raw, tokens[len(prompt) :], timestamps)
            timing.tokens += 1

            if next_token == self.eot:
                break
            if step >= len(prompt) - 1:
                tokens.append(next_token)
        timing.decode_ms += (time.perf_counter() - t0) * 1000

        return tokens

    def _transcribe_chunk_plain(
        self, chunk: np.ndarray, language: str | None, task: str, timestamps: bool, timing: Timing
    ) -> list[int]:
        """The unbound path, kept as the reference implementation and A/B baseline."""
        features = self._features(chunk, timing)

        t0 = time.perf_counter()
        cross = self.encoder.run(self._cross_names, {"input_features": features})
        timing.encode_ms += (time.perf_counter() - t0) * 1000
        cross_inputs = dict(zip(self._cross_names, cross))

        prompt = self._prompt(language, task, timestamps)
        tokens = list(prompt)
        self_cache = self._initial_self_cache()
        mask = np.full((1, 1, 1, self.decode_window), self._mask_ignore, dtype=np.uint16)
        position = np.zeros(1, dtype=np.int32)
        out_names = [o.name for o in self.decoder.get_outputs()]

        t0 = time.perf_counter()
        for step in range(self.decode_window - 1):
            mask[0, 0, 0, self.decode_window - step - 1] = self._mask_attend
            position[0] = step

            feed = {
                "input_ids": np.array([[tokens[step]]], dtype=np.int32),
                "attention_mask": mask,
                "position_ids": position,
                **self_cache,
                **cross_inputs,
            }
            named = dict(zip(out_names, self.decoder.run(None, feed)))

            raw = named["logits"].reshape(-1)
            if step == 0:
                self._record_no_speech(raw)
            next_token = self._next_token(raw, tokens[len(prompt) :], timestamps)
            timing.tokens += 1

            if next_token == self.eot:
                break
            if step >= len(prompt) - 1:
                tokens.append(next_token)

            for out_name in self._self_out:
                self_cache[self._self_out_to_in[out_name]] = named[out_name]
        timing.decode_ms += (time.perf_counter() - t0) * 1000

        return tokens

    def decode_text(self, tokens: list[int]) -> str:
        text_tokens = [t for t in tokens if t < self._first_special]
        return self.tokenizer.decode(text_tokens).strip()

    def segments_for_chunk(
        self, tokens: list[int], offset: float, chunk_end: float, timestamps: bool
    ) -> tuple[list[Segment], float | None]:
        """Turn one window's tokens into segments, plus where it cleanly ended.

        With timestamps the model tells us where utterances begin and end; without
        them the whole window is one segment and the only honest times are its
        boundaries.
        """
        if timestamps:
            parsed, last_closed = self.parse_segments(tokens, offset, chunk_end)
            if parsed:
                return parsed, last_closed
            # No timestamps at all (the aggregate rule never fired for this
            # window): fall back rather than lose the text.
        text = self.decode_text(tokens)
        if not text:
            return [], None
        return [Segment(index=0, start=offset, end=chunk_end, text=text, tokens=tokens)], None

    def transcribe(
        self,
        audio: np.ndarray,
        *,
        language: str | None = None,
        task: str = "transcribe",
        timestamps: bool = True,
        on_segment: "Callable[[Segment], None] | None" = None,
    ) -> tuple[list[Segment], Timing]:
        """Decode the whole recording, advancing by what each window finished.

        A fixed 30 s stride cuts sentences in half at every boundary: the window
        ends mid-utterance and the next one starts mid-utterance. So when a window
        closes an utterance cleanly, the next window starts *there* instead --
        Whisper's own sequential seek. Windows then overlap slightly and cost some
        extra encoder passes, which is the price of not splitting sentences.
        """
        sample_rate = audio_mod.SAMPLE_RATE
        window = audio_mod.CHUNK_SAMPLES
        timing = Timing(audio_seconds=len(audio) / sample_rate)
        segments: list[Segment] = []

        seek = 0
        while seek < len(audio):
            chunk = audio[seek : seek + window]
            tokens = self.transcribe_chunk(
                chunk, language=language, task=task, timestamps=timestamps, timing=timing
            )
            offset = seek / sample_rate
            chunk_end = offset + len(chunk) / sample_rate

            found, last_closed = self.segments_for_chunk(tokens, offset, chunk_end, timestamps)
            if self.last_no_speech >= self.no_speech_threshold:
                # Silence. Whatever came out is invented, so drop it and skip the
                # whole window instead of seeking into the hallucination.
                found, last_closed = [], None
            for segment in found:
                segment.index = len(segments)
                segments.append(segment)
                if on_segment is not None:
                    on_segment(segment)
            timing.chunks += 1

            # Advance to the last clean utterance end -- but only when the window
            # actually produced words. On silence the model closes an empty
            # utterance within a few seconds, and seeking there re-decodes the
            # same silence over and over (90 s of it cost 32 windows before this
            # check). A window with no text has nothing worth re-reading, so skip
            # all of it. The one-second floor covers a degenerate close-at-zero.
            advance = window
            if found and last_closed is not None and len(chunk) == window:
                candidate = int(last_closed * sample_rate)
                if candidate >= sample_rate:  # at least one second
                    advance = candidate
            seek += advance

        return segments, timing
