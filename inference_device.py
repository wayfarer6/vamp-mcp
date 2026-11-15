"""Backend routing; only Ubuntu/NVIDIA has been exercised on project hardware."""


def choose_device(requested='auto'):
    import torch
    requested=str(requested).lower()
    if requested in ('intel-npu','openvino-npu'):
        return 'intel-npu'
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
    # ROCm exposes AMD GPUs through the same torch.cuda namespace.
    if torch.cuda.is_available():
        return '0'
    if hasattr(torch.backends,'mps') and torch.backends.mps.is_available():
        return 'mps'
    try:
        import torch_npu  # noqa: F401
    except ImportError:
        return 'cpu'
    return 'npu:0' if torch.npu.is_available() else 'cpu'


def prepare_detector(model,requested,cache):
    from ultralytics import YOLO
    selected=choose_device(requested)
    key=(str(model),selected)
    if key not in cache:
        if selected=='intel-npu':
            import openvino as ov
            if not any(name=='NPU' or name.startswith('NPU.') for name in ov.Core().available_devices):
                raise RuntimeError('Intel NPU not available; check the OpenVINO package and NPU driver')
            # Exported OpenVINO backend maps device='npu' to Intel, not torch_npu.
            exported=YOLO(model).export(format='openvino',imgsz=1280,batch=1,
                                        dynamic=False,device='cpu',half=False)
            cache[key]=YOLO(exported,task='detect')
        else:
            cache[key]=YOLO(model)
    return cache[key],('npu' if selected=='intel-npu' else selected)
