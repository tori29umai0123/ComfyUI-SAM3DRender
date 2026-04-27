"""HTTP routes for the Gaussian Splatting renderer modal.

Routes:
  GET  /gs_render/editor          — viewer HTML page (vanilla)
  GET  /gs_render/editor_sam3d    — viewer HTML page (SAM3D variant: image
                                    upload + ply save buttons)
  GET  /gs_render/ply             — streams a .ply file from an absolute path
                                    (path passed as ?path=<urlencoded>). ASCII
                                    PLY (e.g. comfyui-sam3dobjects output) is
                                    transparently rewritten to the binary 3DGS
                                    layout the viewer expects; binary PLY is
                                    served as-is.
  POST /gs_render/sam3d_generate  — accepts a multipart image upload, runs
                                    SAM3D Gaussian Splatting (MoGe) in the
                                    isolated subprocess env, returns the
                                    generated PLY *bytes* (binary,
                                    application/octet-stream). The temp
                                    file written by the subprocess is
                                    deleted before the response returns,
                                    so the browser holds the only copy.

Static JS/CSS assets under web/editor/static are served by ComfyUI via
WEB_DIRECTORY at /extensions/ComfyUI-SAM3DRender/editor/static/."""

from __future__ import annotations

import asyncio
import importlib
import logging
import mimetypes
import struct
import sys
import tempfile
import time
import uuid
from pathlib import Path

from aiohttp import web
from server import PromptServer

log = logging.getLogger("GSRender")

_REPO_ROOT = Path(__file__).resolve().parents[1]
_WEB_EDITOR_DIR = _REPO_ROOT / "web" / "editor"

routes = PromptServer.instance.routes


# ---------------------------------------------------------------------------
# SAM3D viewer plumbing — image upload → MoGe → temp PLY
# ---------------------------------------------------------------------------

def _top_level_pkg():
    """Return the ComfyUI-SAM3DRender top-level package module.

    server.py is loaded as ``<pkg>.nodes.server``; we walk up to the
    package itself so we can read its NODE_CLASS_MAPPINGS (populated by
    register_nodes() at __init__ time, including the wrapped SAM3D
    Gaussian Splatting proxy class)."""
    pkg_name = (__package__ or "").rsplit(".", 1)[0]
    if not pkg_name:
        return None
    return sys.modules.get(pkg_name) or importlib.import_module(pkg_name)


def _sam3d_class():
    pkg = _top_level_pkg()
    if pkg is None:
        return None
    return getattr(pkg, "NODE_CLASS_MAPPINGS", {}).get("SAM3DGaussianSplatting")


def _temp_dir() -> Path:
    """Per-process scratch dir for SAM3D viewer artefacts (uploaded
    images + generated PLYs). Kept under tempfile.gettempdir() so the
    OS cleans up if we don't."""
    base = Path(tempfile.gettempdir()) / "comfyui_sam3drender_viewer"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _sweep_temp(max_age_seconds: int = 60 * 60 * 6) -> None:
    """Best-effort cleanup of stale viewer artefacts (>6h)."""
    cutoff = time.time() - max_age_seconds
    for p in _temp_dir().iterdir():
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
        except OSError:
            pass


@routes.get("/gs_render/editor")
async def serve_editor(_request: web.Request) -> web.Response:
    return _serve_editor_page("gs_render.html")


@routes.get("/gs_render/editor_sam3d")
async def serve_editor_sam3d(_request: web.Request) -> web.Response:
    return _serve_editor_page("gs_render_sam3d.html")


def _serve_editor_page(filename: str) -> web.Response:
    path = _WEB_EDITOR_DIR / filename
    if not path.is_file():
        return web.Response(status=404, text=f"editor page not found: {path}")
    return web.FileResponse(
        path,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@routes.post("/gs_render/sam3d_generate")
async def sam3d_generate(request: web.Request) -> web.Response:
    """Receive an image upload, run MoGe via the SAM3D Gaussian Splatting
    isolated subprocess, and stream the resulting PLY bytes back to the
    browser. Nothing is persisted on the server — the temp file used as
    the subprocess write target is deleted before this handler returns,
    so the browser is the sole owner of the data (it holds the bytes in
    memory and offers them via the 'ply保存' button)."""
    sam_cls = _sam3d_class()
    if sam_cls is None:
        return web.json_response(
            {"error": "SAM3DGaussianSplatting node not registered yet"},
            status=503,
        )

    reader = await request.multipart()
    image_field = None
    precision = "auto"
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "image":
            image_field = await part.read(decode=False)
        elif part.name == "precision":
            precision = (await part.text()).strip() or "auto"

    if not image_field:
        return web.json_response({"error": "missing 'image' field"}, status=400)

    # Sweep stale viewer artefacts (files from earlier crashed requests
    # that didn't get to the cleanup step). Best-effort.
    _sweep_temp()

    # The subprocess writes to disk to keep the node's API stable, but we
    # treat the file purely as a transient handoff: read once, delete.
    upload_id = uuid.uuid4().hex[:12]
    viewer_ply_path = _temp_dir() / f"viewer_{upload_id}.ply"

    # PIL → torch IMAGE tensor [1,H,W,3] in main process. The host venv
    # has torch+PIL+numpy; the proxy class serialises the tensor over IPC
    # to the isolation env where MoGe actually runs.
    def _build_inputs():
        from PIL import Image
        import io
        import numpy as np
        import torch

        from .sam3d.load_sam3d_model import build_model_dict

        model = build_model_dict(precision)
        img = Image.open(io.BytesIO(image_field)).convert("RGB")
        arr = np.asarray(img, dtype=np.float32) / 255.0
        return model, torch.from_numpy(arr).unsqueeze(0)

    def _run_node():
        model, image = _build_inputs()
        node = sam_cls()
        # Wrapped FUNCTION dispatches to subprocess; takes ~5–15 s including
        # MoGe load. Run off the event loop so we don't block aiohttp.
        result = node.run(
            model=model,
            image=image,
            _output_path=str(viewer_ply_path),
        )
        # Subprocess IPC serialises tuples as lists — accept either.
        if not isinstance(result, (tuple, list)) or not result:
            raise RuntimeError(f"unexpected result from SAM3D node: {result!r}")
        ply_path = result[0]
        if not ply_path or not Path(ply_path).is_file():
            raise RuntimeError(f"SAM3D node returned invalid ply path: {ply_path!r}")
        return ply_path

    ply_path = None
    try:
        ply_path = await asyncio.get_event_loop().run_in_executor(None, _run_node)
        ascii_bytes = Path(ply_path).read_bytes()
    except Exception as exc:  # noqa: BLE001
        log.exception("[GSRender] SAM3D generate failed")
        try:
            viewer_ply_path.unlink(missing_ok=True)
        except OSError:
            pass
        return web.json_response({"error": str(exc)}, status=500)
    finally:
        # Always clean up the on-disk temp artefact — the browser is now
        # the sole holder of the PLY bytes.
        if ply_path:
            try:
                Path(ply_path).unlink(missing_ok=True)
            except OSError:
                pass

    # The viewer's WebGL worker only parses *binary* PLY — promote the
    # ASCII point cloud the SAM3D node writes into the 17-float 3DGS
    # binary layout (same path the vanilla /gs_render/ply route uses).
    # We hand the browser BOTH versions in one body:
    #   - the ASCII original is what the user gets when they click
    #     「ply保存」 (compact, portable, Blender / MeshLab friendly)
    #   - the binary version is what the WebGL worker actually renders
    #
    # Layout: <4 bytes BE uint32 = ascii_size><ascii bytes><binary bytes>
    try:
        from .render.ply_compat import is_ascii_ply, ascii_ply_to_3dgs_binary

        if is_ascii_ply(ascii_bytes):
            binary_bytes = await asyncio.get_event_loop().run_in_executor(
                None, ascii_ply_to_3dgs_binary, ascii_bytes
            )
        else:
            # Already binary — render-side bytes equal save-side bytes.
            binary_bytes = ascii_bytes
    except Exception as exc:  # noqa: BLE001
        log.exception("[GSRender] ASCII→binary conversion failed")
        return web.json_response(
            {"error": f"ply conversion failed: {exc}"}, status=500
        )

    body = struct.pack(">I", len(ascii_bytes)) + ascii_bytes + binary_bytes
    return web.Response(
        body=body,
        headers={
            "Cache-Control": "no-store",
            # Custom marker so the browser knows it's the dual layout
            # (ASCII-for-save || binary-for-render) and not a single PLY.
            "Content-Type": "application/x-sam3d-dual-ply",
            "X-SAM3D-Suggested-Filename": f"sam3d_{upload_id}.ply",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "X-SAM3D-Suggested-Filename",
        },
    )


@routes.get("/gs_render/editor")
async def serve_editor(_request: web.Request) -> web.Response:
    path = _WEB_EDITOR_DIR / "gs_render.html"
    if not path.is_file():
        return web.Response(status=404, text=f"editor page not found: {path}")
    return web.FileResponse(
        path,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@routes.get("/gs_render/ply")
async def serve_ply(request: web.Request) -> web.Response:
    raw = request.query.get("path", "")
    if not raw:
        return web.Response(status=400, text="missing ?path=")
    try:
        target = Path(raw).expanduser().resolve()
    except Exception as exc:  # noqa: BLE001
        return web.Response(status=400, text=f"bad path: {exc}")
    if not target.is_file():
        return web.Response(status=404, text=f"not a file: {target}")
    suffix = target.suffix.lower()
    if suffix not in (".ply", ".splat"):
        return web.Response(
            status=400,
            text=f"only .ply / .splat files are served, got: {target.suffix}",
        )

    # ASCII PLY detour: the WebGL viewer's worker only parses binary PLY, so
    # transparently rewrite ASCII files (e.g. comfyui-sam3dobjects point clouds
    # and gaussians) to the same 17-float binary 3DGS layout the viewer expects.
    if suffix == ".ply":
        from .render.ply_compat import is_ascii_ply, ascii_ply_to_3dgs_binary

        try:
            with target.open("rb") as f:
                head = f.read(256)
        except OSError as exc:
            return web.Response(status=500, text=f"read failed: {exc}")
        if is_ascii_ply(head):
            try:
                blob = await asyncio.get_event_loop().run_in_executor(
                    None, target.read_bytes
                )
                converted = await asyncio.get_event_loop().run_in_executor(
                    None, ascii_ply_to_3dgs_binary, blob
                )
            except Exception as exc:  # noqa: BLE001
                log.exception("ASCII PLY conversion failed for %s", target)
                return web.Response(status=500, text=f"ply conversion failed: {exc}")
            log.info(
                "serve_ply: converted ASCII → binary 3DGS (%d → %d bytes) for %s",
                len(blob), len(converted), target.name,
            )
            return web.Response(
                body=converted,
                headers={
                    "Cache-Control": "no-store",
                    "Content-Type": "application/octet-stream",
                    "Access-Control-Allow-Origin": "*",
                },
            )

    ctype, _ = mimetypes.guess_type(target.name)
    return web.FileResponse(
        target,
        headers={
            "Cache-Control": "no-store",
            "Content-Type": ctype or "application/octet-stream",
            # Allow the viewer worker / fetch to read the body without CORS hassles.
            "Access-Control-Allow-Origin": "*",
        },
    )


print("[GSRender] Registered routes:")
print("[GSRender]   GET  /gs_render/editor")
print("[GSRender]   GET  /gs_render/editor_sam3d")
print("[GSRender]   GET  /gs_render/ply?path=<absolute path>")
print("[GSRender]   POST /gs_render/sam3d_generate (returns PLY bytes)")
