"""M3 spike: what does ORT 1.27 offer for binding buffers on the QNN EP?

The decode loop re-feeds ~28 MB of cross-attention KV per token. This probe
answers what can be bound once instead: which OrtValue device types exist, what
IOBinding accepts, and whether the EP exposes a shared allocator.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))
from hexscribe_worker.qnn import npu_session  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = (
    ROOT
    / "models"
    / "whisper-small-qnn"
    / "whisper_small_quantized-precompiled_qnn_onnx-w8a16-qualcomm_snapdragon_x_elite"
)

print("OrtValue methods :", [a for a in dir(ort.OrtValue) if not a.startswith("_")])
print()
print("IOBinding methods:", [a for a in dir(ort.IOBinding) if not a.startswith("_")])
print()
print("InferenceSession :", [a for a in dir(ort.InferenceSession) if "alloc" in a.lower() or "binding" in a.lower()])
print()
print("OrtDevice        :", [a for a in dir(ort.OrtDevice) if not a.startswith("_")])
print("OrtMemoryDevType :", [a for a in dir(ort.OrtMemoryInfoDeviceType) if not a.startswith("_")])
print()

sess = npu_session(MODEL_DIR / "decoder.onnx")
print("decoder session providers:", sess.get_providers())

# What device does the EP want its inputs on?
for name in ("get_inputs", "get_outputs"):
    meta = getattr(sess, name)()[0]
    print(f"{name}[0]: {meta.name} {meta.shape} {meta.type}")

print()
try:
    alloc = sess.get_allocator("QnnHtpShared")  # type: ignore[attr-defined]
    print("shared allocator:", alloc)
except Exception as exc:
    print("get_allocator('QnnHtpShared') ->", type(exc).__name__, exc)

arr = np.zeros((12, 1, 64, 199), dtype=np.uint8)
for device in ("cpu", "npu", "qnn_htp_shared"):
    try:
        value = ort.OrtValue.ortvalue_from_numpy(arr, device)
        print(f"ortvalue_from_numpy(device={device!r}) -> ok, device_name={value.device_name()}")
    except Exception as exc:
        print(f"ortvalue_from_numpy(device={device!r}) -> {type(exc).__name__}: {str(exc)[:160]}")

value = ort.OrtValue.ortvalue_from_numpy(arr)
print("update_inplace present:", hasattr(value, "update_inplace"))
