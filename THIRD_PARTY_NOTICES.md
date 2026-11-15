# First-party MIT and third-party notices

The root [MIT license](LICENSE) applies to original project code and documentation unless a file states otherwise. It does not relicense third-party source, models, libraries or virtual machine products.

## Existing vision components

- Microsoft OmniParser v2 `icon_detect/model.pt`: [upstream](https://huggingface.co/microsoft/OmniParser-v2.0), original AGPL-3.0 license preserved at [models/OMNIPARSER-LICENSE](models/OMNIPARSER-LICENSE). Weight files are downloaded separately and excluded from Git. The pinned source revision/hash is in `models/manifest.json`.
- Ultralytics is a separately installed dependency under its upstream license (AGPL-3.0 or an applicable commercial license). Root MIT licensing does not remove that dependency's obligations. Distribution of a combined work must account for the relevant AGPL conditions; do not describe an entire bundled vision stack as MIT-only.
- Other Python/Node packages keep their own licenses. Installing dependencies is not a license grant from this project; preserve their notices when distributing them.

## Virtualization products

VirtualBox, Hyper-V, QEMU, SPICE and their SDKs/binaries are not relicensed by this project. This repository does not bundle hypervisor binaries or a VirtualBox Extension Pack. A third-party MCP adapter's MIT license does not grant rights to a separately licensed hypervisor/Extension Pack.

Any vendored adapter must include its original LICENSE and source URL, pinned revision, file hashes and modification description alongside the imported source. Platform-specific notices are documented in that backend's README.
