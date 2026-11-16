# Windows Microsoft Print to PDF

Robot Framework drives an explicitly selected Windows guest through the VAMP remote MCP server. The included HTML invoice is a local demonstration fixture, not an integration with a real ERP. Input travels through hypervisor devices; QEMU Guest Agent is used only to retrieve and independently validate the resulting PDF.

Prerequisites: Windows with Edge and Microsoft Print to PDF, an interactive desktop with Edge first-run setup already completed, an exchange folder, Ubuntu controller with Poppler (`pdftotext`, `pdfinfo`, `pdftoppm`), and a reachable invoice URL. The guest is fixed at 1920×1080. Recording centers the original frame on a QHD canvas without scaling. The MCP launch JSON stays local and may contain SSH key paths, but must not contain passwords.

```json
{
  "command": "ssh",
  "args": ["-T", "-o", "BatchMode=yes", "you@host", "node /absolute/vamp-mcp/backends/remote_ssh/server.mjs --backend kvm --libvirt-uri qemu:///session"],
  "vm": "explicit-windows-vm-name",
  "evidence_dir": "/absolute/evidence/first-run"
}
```

Serve the included local fixture on the Ubuntu KVM host, or supply your own reachable `DOCUMENT_URL`:

```bash
python3 -m http.server 8766 --bind 127.0.0.1 --directory rpas/windows_print_pdf
```

The default `10.0.2.2` URL is the QEMU user-network host address; other network layouts need a different URL.

The verification JSON declares `backend: kvm`, an absolute `vm_config` path, and the same explicit `vm` name. It selects the existing QGA file exchange, not an arbitrary host command. Use a new PDF name and a new output directory for each run.

```bash
.venv/bin/python scripts/run_rpa.py windows_print_pdf --dryrun
.venv/bin/python scripts/run_rpa.py windows_print_pdf \
  --var MCP_CONFIG:/absolute/mcp.json \
  --var VERIFY_CONFIG:/absolute/verify.json \
  --var PDF_NAME:invoice-unique-run.pdf \
  --listener spice_recording.RecordingListener:2560:1440:False \
  --output /absolute/evidence/first-run
```

Success requires the PDF signature, native Microsoft Print To PDF producer and invoice title, invoice number and total of KRW 192,500. A PDF without a text layer is rendered and verified with local OCR. Screenshots or successful key dispatch alone do not count. OCR and YOLO run locally; replay does not call a language model. Layout changes, printer selection, first-run dialogs and display scaling can require locator repair.
