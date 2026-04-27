"""ComfyUI-SAM3DRender prestartup — ensures the platform-specific
nodes/sam3d/comfy-env.toml exists, then bootstraps comfy-env. The
isolated env (subprocess) is loaded lazily by register_nodes().

NOTE: We deliberately load _env_config via importlib instead of
adding NODE_DIR to sys.path — doing the latter makes our local
``nodes/`` package shadow ComfyUI's top-level ``nodes`` module
(C:\\ComfyUI\\nodes.py), breaking ``nodes.init_extra_nodes``."""

import importlib.util
from pathlib import Path

NODE_DIR = Path(__file__).resolve().parent


def _load_local(name: str) -> object:
    """Load a sibling .py file by absolute path, no sys.path mutation."""
    spec = importlib.util.spec_from_file_location(name, NODE_DIR / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {name} from {NODE_DIR}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


try:
    _env_config = _load_local("_env_config")
    _env_config.ensure_sam3d_toml(NODE_DIR)
except Exception as _exc:
    print(f"[SAM3DRender] env-config generation failed: {_exc}")

try:
    from comfy_env import setup_env
    setup_env()
except Exception as _exc:
    print(f"[SAM3DRender] comfy-env setup_env failed: {_exc}")
