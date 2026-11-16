# Windows host remote input validation

Robot Framework connects to the native Windows VAMP remote MCP server through key-only SSH. The Windows host runs a Debian VirtualBox guest, and the RPA creates a local HTML fixture through its already-open xterm, launches Firefox, clicks a button with the Windows VirtualBox Python SDK and verifies the changed page text using local OCR on the Ubuntu controller.

Prerequisites: the explicit Debian lab desktop is at the verified xterm prompt, fixed at 1920×1080; Firefox is installed; the Windows host has Node, VirtualBox and the matching Python SDK. The page is a local input test, not a production ERP application. The complete Robot/vision stack is run from this repository, separate from the basic VSIX runtime.

```bash
.venv/bin/python scripts/run_rpa.py remote_host_validation --dryrun
.venv/bin/python scripts/run_rpa.py remote_host_validation \
  --var MCP_CONFIG:/absolute/windows-mcp.json \
  --listener spice_recording.RecordingListener:2560:1440:False \
  --output /absolute/new-evidence-directory
```

Use the MCP launch JSON format described in [the PDF RPA](../windows_print_pdf/README.md), with the exact nested VM name and a Windows PowerShell SSH command. The capture is 1920×1080; the listener centers it on a 2560×1440 canvas without scaling. A `succeeded` summary requires OCR of `WAITING FOR INPUT` before the SDK click and `REMOTE INPUT VERIFIED` afterward. Dispatch alone does not count.
