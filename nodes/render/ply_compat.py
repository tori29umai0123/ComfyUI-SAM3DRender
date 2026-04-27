"""ASCII PLY → binary 3DGS PLY conversion shim.

The WebGL viewer in web/editor/static/main.js parses PLY files binary-only
(it ``new DataView``s the bytes immediately after ``end_header\\n``). ASCII
PLY files — including everything written by comfyui-sam3dobjects
(point clouds from SAM3D_DepthEstimate, gaussian splats from SAM3DExportPLY,
which uses ``plydata.text = True`` for VTK.js compatibility) — are
unparseable by that worker as-is.

This module detects ASCII PLY input and rewrites it to the same fixed
17-float binary 3DGS schema produced by ``predict_node._ply_to_bytes``, so
the viewer hits a single binary code path for both native binary 3DGS
files and imported SAM3D files. Plain colored point clouds are promoted to gaussians
by synthesising f_dc / opacity / scale / rotation; full gaussian PLYs just
have their encoding changed.
"""

from __future__ import annotations

import io
import logging
import re

import numpy as np

log = logging.getLogger("GSRender")

SH_C0 = 0.28209479177387814

# Final binary layout — must match _ply_to_bytes() in predict_node.py.
_OUT_PROPS: tuple[str, ...] = (
    "x", "y", "z",
    "nx", "ny", "nz",
    "f_dc_0", "f_dc_1", "f_dc_2",
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
)
_OUT_DTYPE = np.dtype([(name, "<f4") for name in _OUT_PROPS])


def is_ascii_ply(blob: bytes) -> bool:
    """True if ``blob`` starts with a PLY header declaring ASCII format."""
    head = blob[:256].decode("ascii", errors="ignore")
    if not head.startswith("ply"):
        return False
    m = re.search(r"format\s+(\S+)", head)
    return m is not None and m.group(1).lower() == "ascii"


def _split_header_body(blob: bytes) -> tuple[str, bytes]:
    for marker in (b"end_header\n", b"end_header\r\n"):
        idx = blob.find(marker)
        if idx >= 0:
            head_end = idx + len(marker)
            return blob[:head_end].decode("ascii", errors="replace"), blob[head_end:]
    raise ValueError("PLY: end_header not found")


def _parse_vertex_header(text_head: str) -> tuple[int, list[str]]:
    """Return (vertex_count, [property_name, ...]) for the vertex element only.

    Raises if the file lacks a vertex element, uses ``property list`` rows
    (we don't support them — point clouds and gaussians don't either), or
    declares additional elements after vertex (the body would no longer be a
    pure rectangular table)."""
    end_idx = text_head.find("end_header")
    if end_idx < 0:
        raise ValueError("PLY: missing end_header")

    vertex_count: int | None = None
    prop_names: list[str] = []
    in_vertex = False
    saw_vertex = False
    for raw in text_head[:end_idx].splitlines():
        line = raw.strip()
        if line.startswith("element "):
            tokens = line.split()
            if len(tokens) >= 3 and tokens[1] == "vertex":
                if saw_vertex:
                    raise ValueError("PLY: multiple vertex elements")
                vertex_count = int(tokens[2])
                in_vertex = True
                saw_vertex = True
            else:
                if saw_vertex:
                    raise ValueError(
                        f"PLY: unsupported extra element after vertex: {line!r}"
                    )
                in_vertex = False
        elif line.startswith("property ") and in_vertex:
            tokens = line.split()
            if len(tokens) < 3 or tokens[1] == "list":
                raise ValueError(f"PLY: unsupported property line: {line!r}")
            prop_names.append(tokens[-1])

    if vertex_count is None:
        raise ValueError("PLY: no vertex element")
    if not prop_names:
        raise ValueError("PLY: vertex element has no properties")
    return vertex_count, prop_names


def _estimate_pointcloud_log_scale(xyz: np.ndarray, count: int) -> float:
    """Pick a log-scale value to use for every gaussian when the source PLY
    is just a colored point cloud (no scale info).

    Uses ``extent / sqrt(N)`` — a 2D surface density model — because
    point clouds from depth-based pipelines (e.g. comfyui-sam3dobjects'
    SAM3D_DepthEstimate) are per-pixel back-projections that lie on a
    single visible surface, not a volumetric distribution. A
    cube-root denominator over-estimates spacing by ``N^(1/6)`` (~5–10×
    for typical N), which is what made the splats look chunky.

    Falls back to a small constant for degenerate clouds.
    """
    if count <= 1:
        return float(np.log(1e-3))
    extent = float(np.linalg.norm([
        float(np.ptp(xyz[:, 0])),
        float(np.ptp(xyz[:, 1])),
        float(np.ptp(xyz[:, 2])),
    ]))
    if extent <= 0.0:
        return float(np.log(1e-3))
    spacing = extent / max(count ** 0.5, 1.0)
    return float(np.log(max(spacing * 0.5, 1e-5)))


def ascii_ply_to_3dgs_binary(blob: bytes) -> bytes:
    """Convert an ASCII PLY whose vertex element is one of:

      * point cloud  : ``x y z`` + uchar ``red green blue``
      * 3DGS gaussian: ``x y z`` + ``nx ny nz`` + ``f_dc_0..2`` + ``opacity``
                       + ``scale_0..2`` + ``rot_0..3``

    into a fixed 17-float binary 3DGS PLY matching predict_node._ply_to_bytes.

    Splat size is intentionally a viewer-side concern: the WebGL renderer
    multiplies the per-gaussian linear scale by a user slider before
    uploading to the GPU (see web/editor/static/main.js), so we ship a
    sensible baseline here and let the user dial it in live.
    """
    head_text, body = _split_header_body(blob)
    n, prop_names = _parse_vertex_header(head_text)
    name_to_idx = {name: i for i, name in enumerate(prop_names)}

    # Cast every column to float32. uchar 0..255 fits losslessly; everything
    # else is already a float in the source.
    raw = np.loadtxt(
        io.StringIO(body.decode("ascii", errors="replace")),
        dtype=np.float32,
        max_rows=n,
        ndmin=2,
    )
    if raw.shape[0] != n:
        raise ValueError(f"PLY: expected {n} vertices, parsed {raw.shape[0]}")
    if raw.shape[1] != len(prop_names):
        raise ValueError(
            f"PLY: row width {raw.shape[1]} != property count {len(prop_names)}"
        )

    out = np.empty(n, dtype=_OUT_DTYPE)
    out["x"] = raw[:, name_to_idx["x"]]
    out["y"] = raw[:, name_to_idx["y"]]
    out["z"] = raw[:, name_to_idx["z"]]
    for axis in ("nx", "ny", "nz"):
        i = name_to_idx.get(axis)
        out[axis] = raw[:, i] if i is not None else np.zeros(n, dtype=np.float32)

    has_full_gs = (
        all(f"f_dc_{i}"  in name_to_idx for i in range(3))
        and all(f"scale_{i}" in name_to_idx for i in range(3))
        and all(f"rot_{i}"   in name_to_idx for i in range(4))
        and "opacity" in name_to_idx
    )

    if has_full_gs:
        for k in range(3):
            out[f"f_dc_{k}"] = raw[:, name_to_idx[f"f_dc_{k}"]]
            out[f"scale_{k}"] = raw[:, name_to_idx[f"scale_{k}"]]
        out["opacity"] = raw[:, name_to_idx["opacity"]]
        for k in range(4):
            out[f"rot_{k}"] = raw[:, name_to_idx[f"rot_{k}"]]
        log.info("ply_compat: ASCII 3DGS → binary, %d vertices", n)
        return _pack(out, n)

    if not all(c in name_to_idx for c in ("red", "green", "blue")):
        raise ValueError(
            "PLY: vertex element has neither full 3DGS attributes nor RGB; "
            f"got properties={prop_names!r}"
        )
    rn = raw[:, name_to_idx["red"]]   / 255.0
    gn = raw[:, name_to_idx["green"]] / 255.0
    bn = raw[:, name_to_idx["blue"]]  / 255.0
    # Inverse of the viewer's ``visible = 0.5 + SH_C0 * f_dc``.
    out["f_dc_0"] = (rn - 0.5) / SH_C0
    out["f_dc_1"] = (gn - 0.5) / SH_C0
    out["f_dc_2"] = (bn - 0.5) / SH_C0
    out["opacity"] = np.float32(6.0)  # sigmoid(6) ≈ 0.998
    xyz = np.stack([out["x"], out["y"], out["z"]], axis=1)
    log_scale = np.float32(_estimate_pointcloud_log_scale(xyz, n))
    for k in range(3):
        out[f"scale_{k}"] = log_scale
    # Identity quaternion (w, x, y, z).
    out["rot_0"] = np.float32(1.0)
    out["rot_1"] = np.float32(0.0)
    out["rot_2"] = np.float32(0.0)
    out["rot_3"] = np.float32(0.0)
    log.info(
        "ply_compat: ASCII point cloud → binary 3DGS, %d vertices, log_scale=%.4f",
        n, float(log_scale),
    )
    return _pack(out, n)


def _pack(out: np.ndarray, n: int) -> bytes:
    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        f"element vertex {n}\n"
        + "".join(f"property float {name}\n" for name in _OUT_PROPS)
        + "end_header\n"
    )
    return header.encode("ascii") + out.tobytes()
