"""ComfyUI-SAM3DRender — interactive WebGL Gaussian Splatting viewer for
.ply files (3DGS or colored point clouds), plus SAM3D depth → PLY nodes.

Layout:
  nodes/render/   — Gaussian Splatting Render (main process; light deps)
  nodes/sam3d/    — Load SAM3D Model + SAM3D Gaussian Splatting
                    (isolated env via comfy-env, see nodes/sam3d/comfy-env.toml)

The WebGL viewer source under web/editor/static/main.js is adapted from
antimatter15/splat (MIT)."""

from comfy_env import register_nodes

NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS = register_nodes()

# Server routes (page + .ply streaming) — registered as a side-effect of
# importing the module. Wrapped in try/except so a route registration error
# (e.g. PromptServer not yet ready) doesn't take the whole node down.
try:
    from .nodes import server  # noqa: F401
except Exception as _exc:
    print(f"[GSRender] server routes failed to load: {_exc}")

WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
