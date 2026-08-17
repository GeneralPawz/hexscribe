"""M0 spike: can this machine actually run the precompiled Whisper QNN assets on the Hexagon NPU?

Answers three questions, loudly, in order:
  1. Does the QNN plugin EP register and enumerate an NPU device?
  2. Do the precompiled encoder/decoder context binaries load onto the HTP?
  3. What is the I/O contract of those graphs (names, shapes, dtypes)?

Nothing here is production code; it exists to de-risk the engine before any
framework wraps it.

Note on the API: onnxruntime-qnn ships as a *plugin* EP. The legacy
`InferenceSession(providers=["QNNExecutionProvider"])` path only knows built-in
EPs and silently leaves the session on CPU -- which an EPContext graph then
rejects. The plugin path is: register the library, find its OrtEpDevice, and
attach it with SessionOptions.add_provider_for_devices().
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import onnxruntime as ort
import onnxruntime_qnn as qnn

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = (
    ROOT
    / "models"
    / "whisper-small-qnn"
    / "whisper_small_quantized-precompiled_qnn_onnx-w8a16-qualcomm_snapdragon_x_elite"
)


def qnn_npu_device() -> ort.OrtEpDevice | None:
    """Register the QAIRT plugin EP and return its NPU device, if any."""
    if qnn.EP_NAME not in ort.get_available_providers():
        ort.register_execution_provider_library(qnn.EP_NAME, qnn.get_library_path())
    for dev in ort.get_ep_devices():
        if dev.ep_name == qnn.EP_NAME and dev.device.type == ort.OrtHardwareDeviceType.NPU:
            return dev
    return None


def make_session(path: Path, device: ort.OrtEpDevice) -> tuple[ort.InferenceSession, float]:
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    opts.add_provider_for_devices([device], {"backend_path": qnn.get_qnn_htp_path()})
    t0 = time.perf_counter()
    sess = ort.InferenceSession(str(path), sess_options=opts)
    return sess, time.perf_counter() - t0


def describe(session: ort.InferenceSession, label: str) -> None:
    print(f"\n--- {label} ---")
    print("  providers:", session.get_providers())
    ins, outs = session.get_inputs(), session.get_outputs()
    for i in ins[:6]:
        print(f"  in   {i.name:28s} {str(i.shape):28s} {i.type}")
    if len(ins) > 6:
        print(f"  ...  (+{len(ins) - 6} more inputs)")
    for o in outs[:6]:
        print(f"  out  {o.name:28s} {str(o.shape):28s} {o.type}")
    if len(outs) > 6:
        print(f"  ...  (+{len(outs) - 6} more outputs)")


def main() -> int:
    if not MODEL_DIR.exists():
        print(f"!! model dir not found: {MODEL_DIR}")
        return 2

    meta = json.loads((MODEL_DIR / "metadata.json").read_text())
    print(f"asset      : {meta['model_name']} / {meta['precision']} / {meta['runtime']}")
    print(f"tools      : QAIRT {meta['tool_versions']['qairt']}, ORT {meta['tool_versions']['onnx_runtime']}")
    print(f"installed  : onnxruntime {ort.__version__}, onnxruntime-qnn {qnn.__dict__.get('__version__', '?')}")

    device = qnn_npu_device()
    if device is None:
        print("!! no QNN NPU device -- stopping")
        return 1
    print(f"npu device : {device.ep_name} (vendor {device.ep_vendor}, {device.device.type})")

    for name in ("encoder", "decoder"):
        try:
            sess, dt = make_session(MODEL_DIR / f"{name}.onnx", device)
        except Exception as exc:  # noqa: BLE001 - spike: report and continue
            print(f"\n!! {name}: session creation failed: {exc}")
            continue
        describe(sess, f"{name}.onnx  (loaded in {dt:.2f}s)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
