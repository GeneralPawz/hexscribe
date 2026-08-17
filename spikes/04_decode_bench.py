"""M3 spike: where do the ~8.8 ms per decoded token actually go?

IO binding removed every avoidable Python-side copy and changed nothing, so this
breaks one decode step into its parts (rebind / ORT Run / sampler) and then
sweeps the QNN HTP performance modes, which is the other lever available from
outside the graph.

usage: python spikes/04_decode_bench.py [steps]
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))

from hexscribe_worker import audio as audio_mod  # noqa: E402
from hexscribe_worker.whisper_qnn import WhisperQnn  # noqa: E402

MODEL_DIR = (
    ROOT
    / "models"
    / "whisper-small-qnn"
    / "whisper_small_quantized-precompiled_qnn_onnx-w8a16-qualcomm_snapdragon_x_elite"
)
TOKENIZER = ROOT / "models" / "whisper-small-tokenizer" / "tokenizer.json"
STEPS = int(sys.argv[1]) if len(sys.argv) > 1 else 100


def breakdown(engine: WhisperQnn, steps: int) -> None:
    buffers = engine.buffers
    silence = np.zeros(audio_mod.CHUNK_SAMPLES, dtype=np.float32)
    from hexscribe_worker.whisper_qnn import Timing

    engine._features(silence, Timing(), out=buffers.features_np)
    buffers.features.update_inplace(buffers.features_np)
    engine.encoder.run_with_iobinding(buffers.encoder_binding)
    buffers.reset_for_chunk(engine._mask_ignore)

    t_bind = t_run = t_sample = t_small = 0.0
    generated: list[int] = []
    for step in range(steps):
        t0 = time.perf_counter()
        buffers.mask_np[0, 0, 0, engine.decode_window - step - 1] = engine._mask_attend
        buffers.mask.update_inplace(buffers.mask_np)
        buffers.ids_np[0, 0] = engine.sot
        buffers.ids.update_inplace(buffers.ids_np)
        buffers.position_np[0] = step
        buffers.position.update_inplace(buffers.position_np)
        t1 = time.perf_counter()
        buffers.bind_step()
        t2 = time.perf_counter()
        engine.decoder.run_with_iobinding(buffers.decoder_binding)
        buffers.swap()
        t3 = time.perf_counter()
        engine._next_token(buffers.logits.numpy().reshape(-1), generated, True)
        t4 = time.perf_counter()

        t_small += t1 - t0
        t_bind += t2 - t1
        t_run += t3 - t2
        t_sample += t4 - t3

    total = t_small + t_bind + t_run + t_sample
    print(f"\nper-step breakdown over {steps} steps ({total / steps * 1000:.2f} ms/step total):")
    for label, value in (
        ("ids/mask/position update_inplace", t_small),
        ("rebind 48 KV tensors", t_bind),
        ("ORT Run (QNN)", t_run),
        ("sampler (dequant + timestamp rules)", t_sample),
    ):
        print(f"  {label:38s} {value / steps * 1000:6.3f} ms  ({value / total * 100:4.1f}%)")


def sweep_performance_modes(steps: int) -> None:
    import onnxruntime_qnn as qnn

    from hexscribe_worker.qnn import npu_device

    device = npu_device()
    assert device is not None

    print(f"\nHTP performance mode sweep ({steps} decoder Runs each):")
    for mode in ("burst", "sustained_high_performance", "high_performance", "balanced", "default"):
        options = ort.SessionOptions()
        options.log_severity_level = 3
        try:
            options.add_provider_for_devices(
                [device], {"backend_path": qnn.get_qnn_htp_path(), "htp_performance_mode": mode}
            )
            session = ort.InferenceSession(str(MODEL_DIR / "decoder.onnx"), sess_options=options)
        except Exception as exc:
            print(f"  {mode:28s} unsupported: {str(exc)[:80]}")
            continue

        feed = {}
        for meta in session.get_inputs():
            dtype = {"tensor(int32)": np.int32, "tensor(uint16)": np.uint16, "tensor(uint8)": np.uint8}[meta.type]
            feed[meta.name] = np.zeros(tuple(meta.shape), dtype=dtype)

        session.run(None, feed)  # warm up
        t0 = time.perf_counter()
        for _ in range(steps):
            session.run(None, feed)
        elapsed = (time.perf_counter() - t0) / steps * 1000
        print(f"  {mode:28s} {elapsed:6.2f} ms/Run")


def bound_vs_unbound(engine: WhisperQnn, steps: int) -> None:
    """Same session, same tensors, alternating rounds so thermal drift cancels."""
    buffers = engine.buffers
    session = engine.decoder

    feed = {}
    for meta in session.get_inputs():
        dtype = {"tensor(int32)": np.int32, "tensor(uint16)": np.uint16, "tensor(uint8)": np.uint8}[meta.type]
        feed[meta.name] = np.zeros(tuple(meta.shape), dtype=dtype)

    session.run(None, feed)
    session.run_with_iobinding(buffers.decoder_binding)

    bound = unbound = 0.0
    rounds = 5
    per_round = max(steps // rounds, 1)
    for _ in range(rounds):
        t0 = time.perf_counter()
        for _ in range(per_round):
            session.run(None, feed)
        t1 = time.perf_counter()
        for _ in range(per_round):
            session.run_with_iobinding(buffers.decoder_binding)
        t2 = time.perf_counter()
        unbound += t1 - t0
        bound += t2 - t1

    n = rounds * per_round
    print(f"\nbound vs unbound Run, same session ({n} runs each, {rounds} alternating rounds):")
    print(f"  session.run(feed)         {unbound / n * 1000:6.2f} ms/Run")
    print(f"  run_with_iobinding()      {bound / n * 1000:6.2f} ms/Run")
    print(f"  difference                {(unbound - bound) / n * 1000:+6.2f} ms/Run")


def main() -> int:
    engine = WhisperQnn(MODEL_DIR, TOKENIZER)
    breakdown(engine, STEPS)
    bound_vs_unbound(engine, STEPS)
    sweep_performance_modes(STEPS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
