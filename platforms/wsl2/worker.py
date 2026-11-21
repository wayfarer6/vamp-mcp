import base64
import contextlib
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory

from mcp.server.fastmcp import FastMCP

server = FastMCP("VAMP WSL Worker")
ROOT = Path(__file__).resolve().parent
VISION = {"status": "disabled"}
SMOKE = "headless_gui_smoke"
REVIEWED_ROOT = Path("/opt/vamp/reviewed")


def installed_scenarios():
    scenarios = {SMOKE: ROOT / "smoke.robot"}
    if REVIEWED_ROOT.is_dir():
        for folder in REVIEWED_ROOT.iterdir():
            if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", folder.name) or folder.name == SMOKE:
                continue
            script = folder / "run.robot"
            if folder.is_dir() and not folder.is_symlink() and script.is_file() and not script.is_symlink():
                scenarios[folder.name] = script
    return scenarios


@server.tool()
def worker_status() -> dict:
    """Report which execution environment is serving this session."""
    return {"status": "ready", "display": [1920, 1080], "uid": os.getuid(),
            "scenarios": sorted(installed_scenarios()), "vision": VISION}


@server.tool()
def worker_run(scenario: str, confirmed: bool = False) -> dict:
    """Run an installed Robot Framework scenario with explicit operator authorization."""
    script = installed_scenarios().get(scenario)
    if script is None:
        return {"status": "unsupported", "scenario": scenario}
    if not confirmed:
        return {"status": "confirmation_required"}
    with TemporaryDirectory(prefix="vamp-robot-") as folder:
        command = ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24", "robot",
                   "--outputdir", folder, "--report", "NONE", "--log", "NONE",
                   "--variable", f"ARTIFACT:{folder}/result.txt", str(script)]
        try:
            run = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 timeout=30, check=False)
        except subprocess.TimeoutExpired:
            return {"status": "timed_out"}
        result = Path(folder) / "result.txt"
        if run.returncode != 0 or not result.is_file() or result.is_symlink():
            return {"status": "failed", "exit_code": run.returncode}
        outcome = VISION if scenario == SMOKE else {"status": "not_requested"}
        if scenario == SMOKE and VISION["status"] == "verified":
            from vision import inspect_screen
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    outcome = inspect_screen(result.with_suffix(".png"), "vamp wsl gui check")
            except RuntimeError:
                return {"status": "failed", "reason": "gpu_vision_verification_failed"}
        if result.stat().st_size > 16384:
            return {"status": "failed", "reason": "artifact_too_large"}
        payload = result.read_bytes()
        return {"status": "verified", "vision": outcome, "artifact": {"name": "result.txt", "encoding": "base64",
                "sha256": hashlib.sha256(payload).hexdigest(),
                "data": base64.b64encode(payload).decode("ascii")}}


if __name__ == "__main__":
    if os.environ.get("VAMP_WSL_VISION") == "gpu":
        from vision import verify_gpu

        # Keep MCP stdout reserved for protocol messages, including during warm-up.
        with contextlib.redirect_stdout(sys.stderr):
            VISION.update(verify_gpu())
    server.run(transport="stdio")
