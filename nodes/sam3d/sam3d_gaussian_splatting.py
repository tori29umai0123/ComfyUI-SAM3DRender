"""SAM3D Gaussian Splatting — runs MoGe depth estimation on an input
image and writes a colored point-cloud PLY ready for the existing
GaussianSplattingRender viewer (ASCII point cloud → 3DGS via ply_compat).

The pipeline mirrors what sam-3d-objects (E:/sam-3d-objects) does in
`sam3d_objects/pipeline/inference_pipeline_pointmap.py::compute_pointmap`,
but is reimplemented from scratch against the upstream MoGe API so we
inherit MoGe's MIT license and avoid GPL'd wrapper code from
comfyui-sam3dobjects."""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("sam3drender")

# Module-level MoGe cache (persists across node executions). Key: dtype, so
# precision changes invalidate the cache.
_MOGE_MODEL = None
_MOGE_DTYPE = None
_MOGE_PATH = None


class SAM3DGaussianSplatting:
    """MoGe-based depth → colored point cloud PLY for the GS viewer."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("SAM3D_MODEL", {"tooltip": "From Load SAM3D Model"}),
                "image": ("IMAGE", {"tooltip": "Input RGB image"}),
                "filename_prefix": ("STRING", {
                    "default": "sam3d",
                    "tooltip": (
                        "Filename prefix for the saved PLY. "
                        "Resolved via folder_paths.get_save_image_path() so "
                        "subfolders (e.g. 'sam3d/scene1') and ComfyUI's standard "
                        "%date% / %time% tokens work as in SaveImage. The final "
                        "name is <prefix>_<NNNNN>_.ply under ComfyUI/output/."
                    ),
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("ply_path",)
    OUTPUT_TOOLTIPS = ("Path to the colored point-cloud PLY file.",)
    FUNCTION = "run"
    CATEGORY = "SAM3DRender"
    DESCRIPTION = "Estimate depth with MoGe and export a colored point-cloud PLY."

    def run(
        self,
        model: Any,
        image,
        filename_prefix: str = "sam3d",
        _output_path: str | None = None,
    ):
        global _MOGE_MODEL, _MOGE_DTYPE, _MOGE_PATH

        import numpy as np
        import torch
        from PIL import Image
        import folder_paths
        import comfy.utils
        import comfy.model_management as mm
        from moge.model.v1 import MoGeModel

        pbar = comfy.utils.ProgressBar(3)
        t0 = time.time()

        precision = model.get("precision", "bf16")
        moge_path = model.get("moge_path")
        if not moge_path or not Path(moge_path).exists():
            raise FileNotFoundError(
                f"MoGe weights missing: {moge_path!r}. Re-run Load SAM3D Model."
            )

        dtype = {
            "bf16": torch.bfloat16,
            "fp16": torch.float16,
            "fp32": torch.float32,
        }.get(precision, torch.float32)

        if (
            _MOGE_MODEL is None
            or _MOGE_DTYPE != dtype
            or _MOGE_PATH != moge_path
        ):
            log.info("[SAM3DRender] loading MoGe (%s, dtype=%s)", moge_path, dtype)
            mdl = MoGeModel.from_pretrained(moge_path)
            mdl = mdl.to(dtype=dtype)
            mdl.eval()
            _MOGE_MODEL = mdl
            _MOGE_DTYPE = dtype
            _MOGE_PATH = moge_path

        device = mm.get_torch_device()
        _MOGE_MODEL.to(device)
        pbar.update(1)

        img = image[0] if image.dim() == 4 else image
        img_np = (img.detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)

        # Preserve any alpha channel for PLY masking; MoGe itself takes RGB only.
        if img_np.shape[-1] == 4:
            rgb_np = img_np[..., :3]
            alpha = img_np[..., 3]
        else:
            rgb_np = img_np[..., :3] if img_np.shape[-1] >= 3 else img_np
            alpha = np.full(rgb_np.shape[:2], 255, dtype=np.uint8)

        rgb_tensor = (
            torch.from_numpy(rgb_np.astype(np.float32) / 255.0)
            .permute(2, 0, 1)
            .contiguous()
        )

        with torch.no_grad():
            output = _MOGE_MODEL.infer(
                rgb_tensor.to(device=device, dtype=dtype),
                force_projection=False,
                apply_mask=True,
            )

        # MoGe returns points in R3 camera space (X right, Y down, Z forward).
        # Flip Y/Z so the cloud sits upright in the standard 3DGS viewer
        # (matches the camera_to_pytorch3d_camera rotation used upstream).
        points = output["points"].float()  # (H, W, 3)
        flip = torch.tensor(
            [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]],
            dtype=points.dtype,
            device=points.device,
        )
        points = points @ flip.T

        pbar.update(1)

        if _output_path:
            # Server-driven viewer call: write to the caller-supplied
            # absolute path (typically a temp dir) so we don't pollute
            # ComfyUI/output/ with throwaway viewer artefacts.
            ply_path = _output_path
            os.makedirs(os.path.dirname(ply_path) or ".", exist_ok=True)
        else:
            ply_path = self._resolve_ply_path(filename_prefix)
        self._save_ply(points.cpu().numpy(), rgb_np, alpha, ply_path)

        pbar.update(1)
        log.info("[SAM3DRender] PLY saved (%s) in %.1fs", ply_path, time.time() - t0)
        return (ply_path,)

    @staticmethod
    def _resolve_ply_path(filename_prefix: str) -> str:
        """Use ComfyUI's standard SaveImage-style path resolver so the
        prefix supports subfolders ("foo/bar") and %date%/%time% tokens,
        and the counter avoids overwriting prior saves."""
        import folder_paths

        prefix = (filename_prefix or "sam3d").strip() or "sam3d"
        out_dir = folder_paths.get_output_directory()
        full_output_folder, filename, counter, _subfolder, _ = (
            folder_paths.get_save_image_path(prefix, out_dir)
        )
        os.makedirs(full_output_folder, exist_ok=True)
        return os.path.join(full_output_folder, f"{filename}_{counter:05}_.ply")

    @staticmethod
    def _save_ply(pointmap, rgb, alpha, path: str) -> str:
        import numpy as np

        H, W = pointmap.shape[:2]
        points = pointmap.reshape(-1, 3)
        colors = rgb.reshape(-1, 3)
        a = alpha.reshape(-1)

        valid = (
            ~np.isnan(points).any(axis=1)
            & ~np.isinf(points).any(axis=1)
            & (a > 128)
        )
        points = points[valid]
        colors = colors[valid]
        if len(points) == 0:
            raise RuntimeError("MoGe produced no valid 3D points for this image.")

        # ASCII PLY — GaussianSplattingRender / ply_compat rewrites this
        # to the binary 3DGS layout the WebGL worker expects.
        with open(path, "w") as f:
            f.write("ply\n")
            f.write("format ascii 1.0\n")
            f.write(f"element vertex {len(points)}\n")
            f.write("property float x\nproperty float y\nproperty float z\n")
            f.write("property uchar red\nproperty uchar green\nproperty uchar blue\n")
            f.write("end_header\n")
            for (x, y, z), (r, g, b) in zip(points, colors):
                f.write(f"{x} {y} {z} {int(r)} {int(g)} {int(b)}\n")
        return path


NODE_CLASS_MAPPINGS = {
    "SAM3DGaussianSplatting": SAM3DGaussianSplatting,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAM3DGaussianSplatting": "SAM3D Gaussian Splatting",
}
