"""Gaussian Splatting Render terminal node.

Surfaces a confirmed image captured from the WebGL splat viewer modal.
The viewer is opened from a button widget on the node; on confirm, the
captured (optionally cropped) PNG is round-tripped back as a base64
string in a hidden widget, and this node decodes it to an IMAGE tensor."""

from __future__ import annotations

import base64
import io

import numpy as np
import torch
from PIL import Image


def _b64_to_image_tensor(b64_str: str) -> torch.Tensor:
    """Decode a (possibly data-URL prefixed) base64 PNG string into a
    ComfyUI IMAGE tensor of shape (1, H, W, 3), float32 in [0, 1]."""
    if not b64_str:
        return torch.zeros(1, 1, 1, 3, dtype=torch.float32)
    try:
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        raw = base64.b64decode(b64_str)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        arr = np.asarray(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr)[None, ...]
    except Exception as exc:  # noqa: BLE001
        print(f"[GSRender] image decode failed: {exc}")
        return torch.zeros(1, 1, 1, 3, dtype=torch.float32)


class GaussianSplattingRender:
    """Open a WebGL Gaussian Splatting viewer for a .ply file, frame the
    shot (and optionally draw a crop rectangle), and emit the captured
    PNG as an IMAGE tensor."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ply_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": ".ply file path (absolute)",
                }),
            },
            "hidden": {
                "node_id": "UNIQUE_ID",
                "render_image": ("STRING", {"default": ""}),
                # Camera framing snapshot (JSON: viewMatrix + axis dropdown
                # value), persisted across modal opens and ply changes so
                # users land back at their last view.
                "view_state":   ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    OUTPUT_NODE = True
    FUNCTION = "execute"
    CATEGORY = "GaussianSplatting"

    @classmethod
    def IS_CHANGED(cls, ply_path="", node_id="", render_image="", **_):
        return f"{ply_path}|img:{len(render_image or '')}"

    def execute(self, ply_path="", node_id="", render_image="", **_):
        if not render_image:
            raise RuntimeError(
                "[GSRender] レンダリング画像が未確定です。\n"
                "ノード上の『Open Gaussian Splatting Render』ボタンを押し、"
                "ビューアで『Confirm & Close / 確定して閉じる』を押してください。\n"
                "Render image has not been confirmed yet. Click "
                "'Open Gaussian Splatting Render' on the node and press "
                "'Confirm & Close' inside the viewer."
            )
        img_t = _b64_to_image_tensor(render_image)
        return (img_t,)


NODE_CLASS_MAPPINGS = {
    "GaussianSplattingRender": GaussianSplattingRender,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GaussianSplattingRender": "Gaussian Splatting Render",
}
