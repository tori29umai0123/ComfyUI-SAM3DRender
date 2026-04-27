"""SAM3D variant of GaussianSplattingRender.

Same capture flow as the vanilla node — opens a WebGL viewer in a modal,
the user frames a shot and confirms a base64 PNG that we decode to an
IMAGE tensor — but without the ply_path input. Instead, the viewer ships
with an "画像を読み込む" button that uploads an image to
/gs_render/sam3d_generate, where it is fed to the SAM3D Gaussian
Splatting subprocess; the resulting temp .ply is then loaded into the
viewer. A "ply保存" button lets the user download that .ply.

The node only declares ``model: SAM3D_MODEL`` so ComfyUI keeps the
upstream Load SAM3D Model node alive in the graph; the actual MoGe call
happens during the viewer interaction, not at FUNCTION execution."""

from __future__ import annotations

from .render_node import _b64_to_image_tensor


class GaussianSplattingRenderSAM3D:
    """Open the SAM3D-flavoured WebGL viewer, capture a PNG, emit IMAGE."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("SAM3D_MODEL", {
                    "tooltip": "From Load SAM3D Model — kept here so the "
                               "graph encodes the dependency; the viewer "
                               "uses its own MoGe pipeline.",
                }),
            },
            "hidden": {
                "node_id": "UNIQUE_ID",
                "render_image": ("STRING", {"default": ""}),
                # Camera framing snapshot, persisted across modal opens
                # exactly like the vanilla node (axis dropdown + view
                # matrix + splat scale + near clip).
                "view_state":   ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    OUTPUT_NODE = True
    FUNCTION = "execute"
    CATEGORY = "GaussianSplatting"

    @classmethod
    def IS_CHANGED(cls, node_id="", render_image="", **_):
        # Hash only the captured payload; the upstream model dict is
        # opaque (and may be huge/unhashable). Same shape as vanilla.
        return f"sam3d|img:{len(render_image or '')}"

    def execute(self, model=None, node_id="", render_image="", **_):
        if not render_image:
            raise RuntimeError(
                "[GSRender-SAM3D] レンダリング画像が未確定です。\n"
                "ノード上の『Open Gaussian Splatting Render（SAM3D）』ボタンを押し、"
                "ビューアで画像を読み込んでから『Confirm & Close / 確定して閉じる』を押してください。\n"
                "Render image has not been confirmed yet. Click "
                "'Open Gaussian Splatting Render（SAM3D）' on the node, load "
                "an image in the viewer, then press 'Confirm & Close'."
            )
        return (_b64_to_image_tensor(render_image),)


NODE_CLASS_MAPPINGS = {
    "GaussianSplattingRenderSAM3D": GaussianSplattingRenderSAM3D,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GaussianSplattingRenderSAM3D": "Gaussian Splatting Render（SAM3D）",
}
