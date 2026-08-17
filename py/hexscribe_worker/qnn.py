"""ONNX Runtime plugin-EP plumbing for the Qualcomm Hexagon NPU.

onnxruntime-qnn 2.x ships QNN as a *plugin* execution provider: a separate DLL
registered into the ORT environment at runtime. The legacy
`InferenceSession(providers=["QNNExecutionProvider"])` call only knows built-in
providers -- it does not fail, it silently leaves the session on CPU, and a
precompiled EPContext graph then refuses to load with a NOT_IMPLEMENTED error
that names CPU as the only available provider. The supported path is:

    register_execution_provider_library() -> get_ep_devices() -> SessionOptions.add_provider_for_devices()

which is what this module does, once per process.
"""

from __future__ import annotations

import threading
from pathlib import Path

import onnxruntime as ort

_lock = threading.Lock()
_device: "ort.OrtEpDevice | None" = None
_probed = False


class NpuUnavailable(RuntimeError):
    """The Hexagon NPU could not be reached on this machine."""


def npu_device() -> "ort.OrtEpDevice | None":
    """Register the QAIRT plugin EP and return its NPU device, or None.

    Idempotent and thread-safe: registration happens at most once per process.
    """
    global _device, _probed
    with _lock:
        if _probed:
            return _device
        _probed = True
        try:
            import onnxruntime_qnn as qnn
        except ImportError:
            return None
        try:
            if qnn.EP_NAME not in ort.get_available_providers():
                ort.register_execution_provider_library(qnn.EP_NAME, qnn.get_library_path())
            for dev in ort.get_ep_devices():
                if dev.ep_name == qnn.EP_NAME and dev.device.type == ort.OrtHardwareDeviceType.NPU:
                    _device = dev
                    break
        except Exception:
            _device = None
        return _device


def npu_session(
    model_path: str | Path,
    *,
    performance_mode: str = "burst",
    log_severity: int = 3,
) -> ort.InferenceSession:
    """Create an InferenceSession pinned to the Hexagon NPU.

    Raises NpuUnavailable when the EP is missing, so callers can fall back to a
    different engine instead of unknowingly running on CPU.
    """
    device = npu_device()
    if device is None:
        raise NpuUnavailable("QNN execution provider exposes no NPU device on this machine")

    import onnxruntime_qnn as qnn

    options = ort.SessionOptions()
    options.log_severity_level = log_severity
    ep_options = {
        "backend_path": qnn.get_qnn_htp_path(),
        "htp_performance_mode": performance_mode,
    }
    try:
        options.add_provider_for_devices([device], ep_options)
    except Exception:
        # Older/newer EP builds may reject an option key; the backend path alone
        # is the part we cannot do without.
        options = ort.SessionOptions()
        options.log_severity_level = log_severity
        options.add_provider_for_devices([device], {"backend_path": qnn.get_qnn_htp_path()})

    session = ort.InferenceSession(str(model_path), sess_options=options)
    providers = session.get_providers()
    if "QNNExecutionProvider" not in providers:
        raise NpuUnavailable(f"session fell back to {providers}")
    return session


def describe() -> dict:
    """Diagnostics for `hexscribe doctor`-style output."""
    import onnxruntime_qnn as qnn  # noqa: PLC0415

    device = npu_device()
    info = {
        "onnxruntime": ort.__version__,
        "npu_available": device is not None,
        "providers": list(ort.get_available_providers()),
    }
    try:
        info["qnn_backend"] = qnn.get_qnn_htp_path()
    except Exception:
        pass
    return info
