# First-party MIT and third-party notices

The root [MIT license](LICENSE) applies to original project code and documentation unless a file states otherwise. It does not relicense third-party source, models, libraries or virtual machine products.

## Existing vision components

- Microsoft OmniParser v2 `icon_detect/model.pt`: [upstream](https://huggingface.co/microsoft/OmniParser-v2.0), original AGPL-3.0 license preserved at [models/OMNIPARSER-LICENSE](models/OMNIPARSER-LICENSE). Weight files are downloaded separately and excluded from Git. The pinned source revision/hash is in `models/manifest.json`.
- Ultralytics is a separately installed dependency under its upstream license (AGPL-3.0 or an applicable commercial license). Root MIT licensing does not remove that dependency's obligations. Distribution of a combined work must account for the relevant AGPL conditions; do not describe an entire bundled vision stack as MIT-only.
- Other Python/Node packages keep their own licenses. Installing dependencies is not a license grant from this project; preserve their notices when distributing them.

## Virtualization products

VirtualBox, Hyper-V, QEMU, SPICE and their SDKs/binaries are not relicensed by this project. This repository does not bundle hypervisor binaries or a VirtualBox Extension Pack. A third-party MCP adapter's MIT license does not grant rights to a separately licensed hypervisor/Extension Pack.

Any vendored adapter must include its original LICENSE and source URL, pinned revision, file hashes and modification description alongside the imported source. Platform-specific notices are documented in that backend's README.

## Vendored VirtualBox adapter

[chryaner/mcp-virtualbox](https://github.com/chryaner/mcp-virtualbox), revision `b51349126d34824cb211d412fc815f1e2e4ed2a5`, MIT, Copyright (c) 2026 mcp-virtualbox contributors. Its full [LICENSE](third_party/mcp-virtualbox/LICENSE) is retained. Selected source/build/test files are included in `third_party/mcp-virtualbox`; original hashes and local dependency changes are recorded in `PROVENANCE.json`. Integration and test limits are described in [the backend README](backends/virtualbox/README.md).

## Independent guest recorder (GPL-3.0)

[axel-magard/PyAutoGUI-Recorder](https://github.com/axel-magard/PyAutoGUI-Recorder), revision `6cd48a3bee4ef4dd382e3484feaa4360a37a0a5d`, is preserved unmodified with its full [GPL-3.0 LICENSE](third_party/pyautogui-recorder/LICENSE), Python source and image assets. Original hashes are in its `PROVENANCE.json`. The MIT host installer packages this independent program for execution in a guest process; it does not import or relicense its code. Distributed recorder source and notices must remain available under its original license. The VSIX includes that source. Bundled Node dependency notices are generated under the extension's `dist/notices`.

## VAMP guest recorder adaptation

`guest_setup/recorder/vamp-recorder.py` is an explicitly GPL-3.0-only UI adaptation of the recorder workflow, not covered by the root MIT license. It is distributed as source with `RECORDER-LICENSE` (full GPL-3.0 text) and the original recorder source/provenance. It uses thread-safe UI queues, explicit user recording controls and shared-folder saving. The host/server code remains separately MIT licensed.
