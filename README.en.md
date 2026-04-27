[日本語](./README.md) | **English**

# ComfyUI-SAM3DRender

A ComfyUI custom-node package that closes the loop from SAM 3D point
clouds / 3DGS PLYs to a rendered PNG: open any `.ply` in an in-graph
**WebGL Gaussian Splatting viewer**, frame the shot, and capture an
image — all inside the ComfyUI canvas. Ships with the SAM 3D depth
estimation (MoGe) → coloured point cloud PLY pipeline as well.

---

## Nodes

| Node | Inputs | Outputs | Purpose |
|---|---|---|---|
| **Load SAM3D Model** | `precision` (auto / bf16 / fp16 / fp32) | `model` | Auto-downloads MoGe v1 (`Ruicheng/moge-vitl`) into `ComfyUI/models/sam3d/` on first run; emits a config dict |
| **SAM3D Gaussian Splatting** | `model` / `image` / `filename_prefix` | `ply_path` | Runs MoGe depth estimation, applies the R3 → 3DGS camera convention, writes an ASCII colored point cloud PLY to `ComfyUI/output/<prefix>_<NNNNN>_.ply` |
| **Gaussian Splatting Render** | `ply_path` | `image` | Opens any `.ply` (binary 3DGS or ASCII point cloud) in the WebGL viewer, captures a (optionally cropped) PNG |
| **Gaussian Splatting Render（SAM3D）** | `model` | `image` | Same viewer, but with an in-page image picker that runs MoGe → renders, plus a "save PLY" button. Nothing is persisted on the server |

---

## Installation

Drop the directory under `ComfyUI/custom_nodes/` (via ComfyUI Manager
or by hand) and start ComfyUI. On first launch:

1. `comfy-env==0.1.75` is pip-installed into the host venv
2. `_env_config.py` detects the host platform and generates
   `nodes/sam3d/comfy-env.toml`
3. `comfy-env` provisions an **isolated Python 3.12 environment** in
   `nodes/sam3d/_env_*/` (torch, MoGe, utils3d, psutil, einops, tqdm,
   comfy-aimdo, comfy-kitchen, …)
4. SAM3D nodes run inside that isolation env via subprocess proxies, so
   the host ComfyUI venv (typically Python 3.11) is left untouched

### Supported platforms

Branched in `_env_config.detect_target()`:

| Target | OS / arch | Python |
|---|---|---|
| `win-x64` | Windows AMD64 | 3.12 |
| `linux-x64` | Linux x86_64 | 3.12 |
| `dgx-spark` | Linux aarch64 (Grace + GB10 etc.) | 3.12 |

The CUDA version is auto-detected by comfy-env on the host (e.g.
CUDA 12.8 → torch 2.8 cu128).

### Model files

| Use | Repo | License | Location |
|---|---|---|---|
| MoGe v1 (point map) | `Ruicheng/moge-vitl` | Apache 2.0 / no auth required | `ComfyUI/models/sam3d/model.pt` |

---

## Usage

### 1. Generate a PLY in a workflow

```
[Image] → [Load SAM3D Model] → [SAM3D Gaussian Splatting] → ply_path → [Gaussian Splatting Render]
                                       ↑
                                   filename_prefix controls the output name
```

`filename_prefix` follows the same rules as ComfyUI's stock `SaveImage`
node (subfolders like `prefix/scene1`, `%date%` / `%time%` tokens, and
ComfyUI's auto counter to avoid overwrites).

### 2. End-to-end inside the viewer (SAM3D variant)

```
[Load SAM3D Model] → [Gaussian Splatting Render（SAM3D）]
```

Click **Open Gaussian Splatting Render（SAM3D）** to launch the modal,
then:

- **画像を読み込む (Load image)** — pick an image, server runs MoGe in
  the isolation subprocess and **streams the resulting PLY bytes back
  to the browser** (ASCII for save + binary 3DGS for render). The
  server-side temp file is deleted before the response returns.
- **撮影範囲指定 (Frame)** — drag a red rectangle, then **Confirm &
  Close** to push the captured PNG back to the node.
- **ply保存 (Save PLY)** — wraps the in-memory ASCII PLY in a `Blob`
  and triggers a browser download (the resulting file opens in
  Blender / MeshLab / CloudCompare without conversion).

The PLY generated through the viewer is **never** written to
`ComfyUI/output/`. Reopening the modal restores the previously loaded
PLY automatically (session cache, scoped to the lifetime of the
ComfyUI page).

---

## Viewer controls

| Action | Effect |
|---|---|
| Left drag | Rotate in place (yaw + pitch, axis-locked) |
| Right drag | Roll |
| Middle drag | Pan |
| Wheel | Zoom |
| W/A/S/D | Fly camera / Space, Q: up / E, X: down |
| Shift / Ctrl | Sprint (×3) / fine (×0.3) |
| Arrow keys | Fine rotation |
| R | Reset camera |
| Ctrl+Enter | Confirm & Close |

The camera panel exposes the world-up axis (Y / -Y / Z / -Z), rotation,
position, **field of view (FoV)**, gaussian size, and a near-clip
distance. The FoV and Splat Size sliders **commit on mouse-release**
(updates are deferred during drag to avoid stutter on heavy scenes).

---

## License

This project is a derivative work that inherits its license terms from
two upstream sources. Redistributions must include `LICENSE.splat` and
`LICENSE.SAM` alongside the project.

| Component | Upstream | License |
|---|---|---|
| WebGL viewer (`web/editor/static/main.js`, etc.) | [antimatter15/splat](https://github.com/antimatter15/splat) (Kevin Kwok) | MIT — `LICENSE.splat` |
| Depth → PLY pipeline (`nodes/sam3d/`) | [facebookresearch/sam-3d-objects](https://github.com/facebookresearch/sam-3d-objects) (Meta Platforms), reimplemented against the upstream API | SAM License — `LICENSE.SAM` |
| Project-specific code (node wrappers, server routes, widgets) | — | MIT (uses `LICENSE.splat` terms for consistency) |

See [`LICENSE`](./LICENSE) for the combined notice.
