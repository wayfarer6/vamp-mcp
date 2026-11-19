"""Backend routing; only Ubuntu/NVIDIA has been exercised on project hardware."""


def openvino_device_available(device):
    try:
        import openvino as ov
        return any(name == device or name.startswith(device + '.') for name in ov.Core().available_devices)
    except (ImportError, OSError, RuntimeError):
        return False


def choose_device(requested='auto'):
    import torch
    requested=str(requested).lower()
    if requested in ('intel-npu','openvino-npu','intel-gpu','openvino-gpu'):
        return requested.replace('openvino-', 'intel-')
    if requested in ('amd','rocm'):
        if not torch.version.hip or not torch.cuda.is_available():
            raise RuntimeError('ROCm was requested but this Torch/runtime has no available AMD GPU')
        return '0'
    if requested in ('apple','mps'):
        if not hasattr(torch.backends,'mps') or not torch.backends.mps.is_available():
            raise RuntimeError('Apple MPS was requested but is not available')
        return 'mps'
    if requested in ('ascend','ascend-npu','npu') or requested.startswith('npu:'):
        import torch_npu  # noqa: F401; registers torch.npu
        if not torch.npu.is_available():
            raise RuntimeError('Ascend NPU was requested but CANN/TorchNPU has no available device')
        return requested if requested.startswith('npu:') else 'npu:0'
    if requested in ('nvidia','cuda'):
        if torch.version.hip or not torch.cuda.is_available():
            raise RuntimeError('NVIDIA CUDA was requested but no NVIDIA CUDA device is available')
        return '0'
    if requested!='auto':
        return requested
    try:
        import torch_npu  # noqa: F401; registers torch.npu
        if torch.npu.is_available():
            return 'npu:0'
    except (ImportError, OSError, RuntimeError, AttributeError):
        pass
    if openvino_device_available('NPU'):
        return 'intel-npu'
    # ROCm exposes AMD GPUs through the same torch.cuda namespace.
    if torch.cuda.is_available():
        return '0'
    if hasattr(torch.backends,'mps') and torch.backends.mps.is_available():
        return 'mps'
    if hasattr(torch, 'xpu') and torch.xpu.is_available():
        return 'xpu'
    if openvino_device_available('GPU'):
        return 'intel-gpu'
    return 'cpu'


def prepare_detector(model,requested,cache):
    from pathlib import Path
    from ultralytics import YOLO
    model=str(Path(model).expanduser().resolve())
    selected=choose_device(requested)
    key=(str(model),selected)
    if key not in cache:
        if selected in ('intel-npu', 'intel-gpu'):
            hardware = selected.removeprefix('intel-').upper()
            if not openvino_device_available(hardware):
                raise RuntimeError(f'Intel {hardware} not available; check the OpenVINO package and driver')
            # The exported OpenVINO backend maps npu and xpu to Intel devices.
            exported=YOLO(model).export(format='openvino',imgsz=1280,batch=1,
                                        dynamic=False,device='cpu',half=False)
            cache[key]=YOLO(exported,task='detect')
        else:
            cache[key]=YOLO(model)
    return cache[key], {'intel-npu': 'npu', 'intel-gpu': 'xpu'}.get(selected, selected)
