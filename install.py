"""ComfyUI-SAM3DRender install entry — generates the platform-specific
nodes/sam3d/comfy-env.toml then delegates to comfy-env.

NOTE: _env_config is loaded via importlib so we never add NODE_DIR to
sys.path. Doing the latter would let our local ``nodes/`` package
shadow ComfyUI's top-level ``nodes`` module (C:\\ComfyUI\\nodes.py)
when install.py is invoked from ComfyUI's process."""

import importlib.util
import sys
from pathlib import Path

NODE_DIR = Path(__file__).resolve().parent


def _load_local(name: str) -> object:
    spec = importlib.util.spec_from_file_location(name, NODE_DIR / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {name} from {NODE_DIR}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_env_config = _load_local("_env_config")
_env_config.ensure_sam3d_toml(NODE_DIR)

# comfy-env 0.1.75 calls Path.is_junction() during the Windows env-move
# step, but that method only exists in Python 3.12+. Some ComfyUI venvs
# are still on 3.11 — patch the shim before calling install().
if sys.platform == "win32" and not hasattr(Path, "is_junction"):
    import os as _os

    def _is_junction(self):
        try:
            return bool(_os.readlink(self))
        except (OSError, ValueError):
            return False

    Path.is_junction = _is_junction  # type: ignore[attr-defined]

from comfy_env import install  # noqa: E402

install()
