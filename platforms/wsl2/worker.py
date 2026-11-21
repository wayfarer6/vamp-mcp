import base64
import contextlib
import hashlib
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from mcp.server.fastmcp import FastMCP

server = FastMCP("VAMP WSL Worker")
ROOT = Path(__file__).resolve().parent
VISION = {"status": "disabled"}


@server.tool()
def worker_status() -> dict:
    """Report which execution environment is serving this session."""
    return {"status": "ready", "display": [1920, 1080], "uid": os.getuid(),
            "scenarios": ["headless_gui_smoke"], "vision": VISION}


@server.tool()
def worker_run(scenario: str, confirmed: bool = False) -> dict:
    """Run an installed Robot Framework scenario with explicit operator authorization."""
    if scenario != "headless_gui_smoke":
        return {"status": "unsupported", "scenario": scenario}
    if not confirmed:
        return {"status": "confirmation_required"}
    with TemporaryDirectory(prefix="vamp-robot-") as folder:
        command = ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24", "robot",
                   "--outputdir", folder, "--report", "NONE", "--log", "NONE",
                   "--variable", f"ARTIFACT:{folder}/result.txt", str(ROOT / "smoke.robot")]
        try:
            run = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 timeout=30, check=False)
        except subprocess.TimeoutExpired:
            return {"status": "timed_out"}
        result = Path(folder) / "result.txt"
        if run.returncode != 0 or not result.is_file():
            return {"status": "failed", "exit_code": run.returncode}
        outcome = VISION
        if VISION["status"] == "verified":
            from vision import inspect_screen
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    outcome = inspect_screen(result.with_suffix(".png"), "vamp wsl gui check")
            except RuntimeError:
                return {"status": "failed", "reason": "gpu_vision_verification_failed"}
        payload = result.read_bytes()
        if len(payload) > 16384:
            return {"status": "failed", "reason": "artifact_too_large"}
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
