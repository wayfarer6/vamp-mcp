# Debian desktop container

Use the same OCI image recipe for native Linux Podman, a Podman machine on Windows/WSL 2, or a Podman engine in a Debian VM. This is a desktop **container image**, not the separate headless Debian Packer/Vagrant host box.

## Build the image

When you have a rootless Podman engine, open a shell that targets that engine. From the source checkout:

```sh
podman build -t localhost/vamp-debian-desktop:dev -f containers/debian-desktop/Containerfile containers/debian-desktop
```

To add the VAMP Recorder, build the non-root recorder image from the desktop
image. Run these commands from the repository root:

```sh
podman build --pull=never --build-context recorder=guest_setup/recorder \
  --build-context vault=guest_setup/vault \
  -f containers/debian-desktop/Containerfile.recorder \
  -t localhost/vamp-debian-recorder:dev containers/debian-desktop
```

Use the recorder image ID in your viewer allowlist. Open a standalone MCP
desktop link in `control` mode, then launch **VAMP Recorder** from the XFCE
Applications menu. Press F8 to start and stop, then choose **Save Python**.
The recording stays in `/home/desktop/Recordings`. With the disposable tmpfs
home, copy out the individual reviewed file before stopping the container.
VS Code's embedded viewer supports viewing and capture.

The same recipe can be used with `docker build` on a separately configured Docker host. The default base is the official Debian trixie-slim image; before distributing a golden image, supply its independently verified digest through the `DEBIAN_BASE` build argument and record the produced image digest. Do not copy work documents, browser state, credentials, a Vault database, or key files into the image or its build context.

The image installs a minimal XFCE desktop, Chromium, LibreOffice, Korean fonts, noVNC and websockify from Debian packages. The virtual display is 1920×1080. **The container does not listen on a VNC or websockify port.** Its fixed screen helpers pass pixels over a managed subprocess only. Do not publish raw VNC or websockify on a public or LAN interface, and do not disable Chromium's sandbox to make it run.

Xvfb disables RandR so guest applications cannot resize the framebuffer. The
noVNC client scales to fit the browser window. Capture and viewer readiness
continue to require the native 1920×1080 framebuffer.

## Create a separate Debian VM for Podman

On a supported native host, **Open Containers → Create Debian VM** queues a
headless Packer and Vagrant build from your verified local Debian installer
ISO. See the [Debian VM build guide](../backends/packer/podman/README.md).
Windows uses VirtualBox for this path, while native Linux also supports KVM
with Vagrant libvirt. The build retains a private, user-specific box; do not
publish it. A Vagrant startup is not engine verification. Independently confirm
the new guest's SSH host key, numeric UID and rootless socket before using a
named connection. WSL remains independent and is never activated by this flow.

## View or capture a desktop

This prerelease requires an independently verified immutable desktop image ID. Record it with `podman image inspect localhost/vamp-debian-desktop:dev --format '{{.Id}}'` after verifying the built image. For VS Code, configure the application setting `vamp.podman.desktopImageIds`. For a standalone MCP server, provide the IDs in the startup environment variable `VAMP_DESKTOP_IMAGE_IDS` (comma-separated). Screen tools reject unmanaged images, root or privileged workload settings, and writable root filesystems. For a preview, use a read-only container with the image's non-root user and no host mounts. The only workspace exception is a managed, revalidated native-Linux attachment described below; an arbitrary bind-mounted container is not eligible. Start one using the recipe's [disposable smoke instructions](../containers/debian-desktop/README.md).

- **VS Code:** Open **Containers**, select the engine, then **Open Desktop** or **Capture desktop** on a running container row. The in-editor viewer is view-only. If the webview cannot establish an eligible local origin, the viewer fails closed and the snapshot remains available.
- **Standalone MCP:** `podman_view_container_screen` returns JSON containing `url`, `container_id`, `mode`, and `scope: "same_machine"`. For human keyboard/mouse control, explicitly request `mode: "control"` and obtain approval for that exact target. The AI should send the complete URL only to that requester in a private conversation, never to logs, shared chats, screenshots, or release notes. The URL is reusable during one short session with no password prompt. Open it in the browser **on the computer that runs MCP**. A remotely hosted MCP makes its own loopback URL, not the user's PC loopback. Do not broaden the bind or copy its URL to resolve that topology automatically.
- **MCP capture:** `podman_capture_container_screen` returns one verified 1920×1080 PNG for the selected desktop. Capture only at the user's request; do not capture while credentials are entered.

### Control an approved desktop from host Robot/Python

Install the standalone `vamp-mcp` package and run Robot/Python with the VAMP
checkout and its VNC dependencies. Build the desktop image from the same
checkout so it contains the RPA input helper. Set `VAMP_DESKTOP_IMAGE_IDS` in the host
environment. Use `podman_check` and `podman_list` to obtain the current
connection binding and the full container ID. After the user has approved
RPA control of that exact target, open the stream with `VMRobot.Connect Podman`.

```robot
*** Settings ***
Library           vm_robot.VMRobot
Suite Teardown    Disconnect Spice

*** Test Cases ***
Inspect Approved Desktop
    Connect Podman    ${CONNECTION}    ${CONTAINER_ID}    ${BINDING}    confirmed=${True}
    Capture Guest Screen    artifacts/podman-screen.png
```

Use the usual `Guest Click`, `Guest Write`, and `Guest Hotkey` keywords after
checking the screen. Screen recognition runs on the host against the captured
framebuffer. The `vamp-mcp podman-screen` subprocess carries RFB over private
stdin/stdout pipes and uses the same trusted-image, rootless and connection
checks as the viewer. The stream closes when Robot disconnects and has the
same duration and byte limits as the managed viewer. On Windows, use
`cli=<absolute path to vamp-mcp.mjs>` if the npm shim is outside the usual
installation layout.

Local browser listeners are restricted to `127.0.0.1` and allocate the lowest open port from 6080 through 6111. Knowledge of the port is not access; the private URL contains a session capability. Browser and VS Code viewer paths are still awaiting real engine/UI testing; clipboard and file transfer are disabled in the fixed screen helper.

## Native Linux: attach an already-opened VeraCrypt workspace

With both VAMP and VAMP Vault running in VS Code, set the owner-only workspace
configuration's optional `credentialEntry` to the managed `VeraCrypt/…`
entry bound to the volume. Call `podman_workspace_unlock` on the checked local
connection and approve the exact volume and mount directory in VS Code.
Then run `podman_workspace_check` and approve the resulting attachment.
In the unified MCP server, `vault_attach_container` is an alias of
`podman_workspace_attach`. In the standalone Vault server, first call
`vault_attach_container` without arguments to check the workspace. To attach,
call the same Vault server with the returned `binding`, `approval_id`
and `confirm: true`.

This prerelease adds a narrow source implementation for **native Linux, same-user rootless Podman, `local-linux` only**. WSL and SSH targets, including an engine in a remote Debian VM, are unavailable for this attachment flow. A Debian VM can use it only when VAMP and rootless Podman both run locally inside that native Linux guest. Engine connection, mounted-volume identity, desktop readiness and real application read/write are separate checks.

Unlock and mount the intended VeraCrypt volume yourself using an approved local procedure before checking it. VAMP does **not** unlock a volume, request a password, store a key, create a host mount or substitute an empty directory for a missing mount. Keep the image, credentials and task workspace separate. Never put a KDBX database, private key, whole vault, host display socket or Podman socket in the workload scope.

### Owner-controlled configuration

Create one JSON file owned by the same Linux user, with permissions **0600**, outside the container's work directory. Configure its absolute path through the VS Code **user/global** setting `vamp.podman.workspaceConfigPath`, not a repository/workspace setting, or through `VAMP_WORKSPACE_CONFIG` in a standalone MCP server's startup environment. No path or mount configuration is accepted from an MCP tool call or webview message.

The file has exactly these fields; use real, verified local paths rather than copying placeholders:

| Field | Required value |
| --- | --- |
| `veracryptPath` | Absolute path to the installed VeraCrypt executable used for read-only mount inspection |
| `volumePath` | Absolute path identifying the already-unlocked VeraCrypt volume |
| `mountPoint` | Existing absolute mount point of that exact volume |
| `directory` | Existing dedicated task subdirectory strictly below `mountPoint`, not the volume root |
| `workloadId` | 1–48 lowercase letters, digits or hyphens; first character must be a letter or digit |
| `imageId` | Already-installed, independently trusted immutable image ID: 64 lowercase hexadecimal characters, without `sha256:`; also present in `vamp.podman.desktopImageIds` or `VAMP_DESKTOP_IMAGE_IDS` |
| `protectedPaths` | Nonempty array of existing absolute paths to protected material outside the task scope; neither ancestors nor descendants of `directory` |

The checks reject ambiguous paths, unsafe ownership/permissions, unexpected volume or folder identity, and overlapping protected material. Do not broaden the scope or remove protected paths just to pass a failed check. No image is downloaded by attachment.

### Check, approve, then attach

- **VS Code:** Select `local-linux`, choose **Check workspace**, inspect the result, then **Create workspace desktop**. The explicit modal authorizes the checked attachment, not arbitrary future mounts.
- **MCP:** Call `podman_workspace_check` with `connection: "local-linux"` and the current opaque connection `binding`. A successful check returns `status: "ready_to_attach"` and `approval_id`. Explain the proposed new workload, `/workspace` read/write access and network isolation, then obtain the user's explicit approval. Only then call `podman_workspace_attach` with that same `connection`, `binding`, `approval_id`, and `confirmed: true`. A check or an `approval_id` is not itself user consent. If configuration, binding or mount identity changes, check again and obtain fresh approval.

Attachment reserves the local operation, checks same-user Podman writers, and creates a **new disposable desktop container** from the installed trusted image. It is rootless, has a read-only root filesystem, no network, and only the approved dedicated directory mounted read/write at `/workspace`. Existing containers are untouched: this is not restart, reconfiguration or in-place recreation. Managed local viewer/capture is available subject to the screen checks above. Save work in `/workspace`; desktop/home state is temporary. Network isolation means the desktop cannot browse the Internet.

The writer check covers the same user's Podman containers, **not every host process, another user or another engine**. The reservation prevents overlapping managed attach operations; it is not a system-wide file lock. Keep unrelated writers closed. `actual_read_write_verified: false` remains honest even after an attachment reports success: real file-write and full OCI/desktop integration have not yet been verified. Do not tell the user that a document was saved or the workspace is fully ready without checking the actual result.

### Finish before dismounting

For MCP, save and close applications, confirm the exact managed container,
then call `podman_workspace_detach` with its full ID and checked connection
binding. A successful response verifies that the container and overlapping
same-user Podman mounts are absent. Then confirm `podman_workspace_lock`
to dismount. It rechecks same-user Podman mounts across the entire volume
and any disk attachments registered by Vault before calling VeraCrypt.

Save and close applications, stop the newly created workload, then refresh and verify that it is gone and the attachment is released **before manually dismounting VeraCrypt**. The workload is disposable; stopping it does not delete files saved in the approved task directory. Do not dismount while a workload might still write. If attachment fails or its state is uncertain, inspect the local container inventory before retrying or dismounting; do not assume rollback completed.

**Existing VAMP Vault unmount operations are not guarded by this workspace flow.** It does not intercept Vault or manual dismounts, unlock secrets, or change credential handling. Use only explicitly approved dummy volumes and non-secret files for integration tests; no real secrets or personal work documents.

## MCP and UI boundary

Use **VAMP MCP** and **VAMP Vault** as the two registrations. `Open Containers` remains a VS Code view. Select an explicit rootless engine before listing containers. Detection does not install or enable WSL. Other SSH/WSL container inventory and desktop viewing remain separate from the native-Linux-only workspace attachment.

`podman_workspace_plan` remains a separate read-only planning interface. It does not authorize attachment or accept caller-asserted mount evidence. Use the new `podman_workspace_check` → explicit approval → `podman_workspace_attach` flow for the configured native-Linux source. Never infer workspace access from connection success, `vault_status`, a path string or a planner's recommendation alone.
