# Third-party notices

The root [MIT license](LICENSE) applies to original VAMP Vault code and documentation. It does not
relicense third-party source, libraries or the products this extension drives.

## Bundled libraries

The MCP server is bundled with `esbuild`; the licenses of the inlined packages are copied into
`dist/notices/dependencies/` at build time and listed in `dist/notices/DEPENDENCIES.json`.

| Package | License | Upstream |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| `zod` | MIT | https://github.com/colinhacks/zod |

## Programs downloaded at run time (not redistributed)

| Program | License | Source |
| --- | --- | --- |
| KeePassXC (`keepassxc-cli`) | GPL-2.0 / GPL-3.0 | https://github.com/keepassxreboot/keepassxc/releases |
| VeraCrypt (`veracrypt`) | Apache-2.0 / TrueCrypt License 3.0 | https://github.com/veracrypt/VeraCrypt/releases |

This extension contains no copy of either program. **VAMP Vault: Set Up KeePassXC & VeraCrypt CLI**
downloads the official release for the current platform on the user's machine, verifies the
publisher's SHA-256, and runs it from the extension's storage directory. Each program keeps its own
license and its own update channel; a KeePassXC or VeraCrypt already installed on the system is used
first, and that installation's licensing terms are the user's own.

Neither program is relicensed, modified or sublicensed here. If you redistribute an offline bundle
that includes them, carry their license files and source offers as their terms require.

## Database and volume formats

`.kdbx` (KeePass 2.x) and VeraCrypt volumes are the user's own encrypted files. This extension does
not weaken their protection, does not implement a fallback password, and does not store the master
password outside VS Code secret storage.
