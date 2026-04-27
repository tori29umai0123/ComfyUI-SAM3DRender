"""Load SAM3D Model — downloads MoGe weights on first use and emits a
lightweight config dict consumed by SAM3D Gaussian Splatting.

This is intentionally a thin wrapper: model construction happens in the
downstream node so the main process doesn't pin VRAM just by having the
loader on the canvas. The dict is the contract between the two nodes."""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("sam3drender")

# MoGe v1 ViT-L checkpoint (matches sam-3d-objects' depth backbone).
MOGE_REPO_ID = "Ruicheng/moge-vitl"
MOGE_FILENAME = "model.pt"


def _models_dir() -> Path:
    """ComfyUI/models/sam3d/ — created on first call."""
    import folder_paths

    target = Path(folder_paths.models_dir) / "sam3d"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _ensure_moge_weights() -> Path:
    """Download MoGe v1 model.pt into ComfyUI/models/sam3d/ if missing."""
    target = _models_dir() / MOGE_FILENAME
    if target.exists() and target.stat().st_size > 0:
        return target

    from huggingface_hub import hf_hub_download

    log.info("[SAM3DRender] downloading MoGe weights from %s ...", MOGE_REPO_ID)
    downloaded = hf_hub_download(
        repo_id=MOGE_REPO_ID,
        filename=MOGE_FILENAME,
        local_dir=str(target.parent),
    )
    return Path(downloaded)


def _resolve_precision(precision: str = "auto") -> str:
    """Resolve "auto" → bf16/fp16/fp32 based on the host GPU."""
    if precision != "auto":
        return precision
    import comfy.model_management as mm

    device = mm.get_torch_device()
    if mm.should_use_bf16(device):
        return "bf16"
    if mm.should_use_fp16(device):
        return "fp16"
    return "fp32"


def build_model_dict(precision: str = "auto") -> dict:
    """Construct the SAM3D_MODEL dict the SAM3D Gaussian Splatting node
    expects. Reusable from the node FUNCTION (subprocess) and from the
    HTTP routes that drive the SAM3D viewer (main process)."""
    return {
        "moge_path": str(_ensure_moge_weights()),
        "precision": _resolve_precision(precision),
    }


class LoadSAM3DModel:
    """Resolve precision + ensure MoGe weights are on disk, then hand a
    config dict to SAM3D Gaussian Splatting."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "precision": (
                    ["auto", "bf16", "fp16", "fp32"],
                    {
                        "default": "auto",
                        "tooltip": "Inference precision. auto = bf16 on Ampere+, fp16 on Volta/Turing, fp32 otherwise.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("SAM3D_MODEL",)
    RETURN_NAMES = ("model",)
    OUTPUT_TOOLTIPS = ("Config for SAM3D Gaussian Splatting.",)
    FUNCTION = "load_model"
    CATEGORY = "SAM3DRender"
    DESCRIPTION = "Download MoGe weights (first run only) and emit a config for SAM3D Gaussian Splatting."

    def load_model(self, precision: str = "auto"):
        model = build_model_dict(precision)
        log.info("[SAM3DRender] LoadSAM3DModel precision=%s", model["precision"])
        return (model,)


NODE_CLASS_MAPPINGS = {
    "LoadSAM3DModel": LoadSAM3DModel,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadSAM3DModel": "Load SAM3D Model",
}
