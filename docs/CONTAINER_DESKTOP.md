# Debian desktop container

Use the same OCI image recipe for native Linux Podman, a Podman machine on Windows/WSL 2, or a Podman engine in a Debian VM. This is a desktop **container image**, not the separate headless Debian Packer/Vagrant host box.

## Build the image

When you have a rootless Podman engine, open a shell that targets that engine. From the source checkout:

```sh
podman build -t localhost/vamp-debian-desktop:dev -f containers/debian-desktop/Containerfile containers/debian-desktop
```

The same recipe can be used with `docker build` on a separately configured Docker host. The default base is the official Debian trixie-slim image; before distributing a golden image, supply its independently verified digest through the `DEBIAN_BASE` build argument and record the produced image digest. Do not copy work documents, browser state, credentials, a Vault database, or key files into the image or its build context.

The image installs a minimal XFCE desktop, Chromium, LibreOffice, Korean fonts, noVNC and websockify from Debian packages. The virtual display is 1920×1080. **The container does not listen on a VNC or websockify port.** Its fixed screen helpers pass pixels over a managed subprocess only. Do not publish raw VNC or websockify on a public or LAN interface, and do not disable Chromium's sandbox to make it run.

## View or capture a desktop

This prerelease requires an independently verified immutable desktop image ID. Record it with `podman image inspect localhost/vamp-debian-desktop:dev --format '{{.Id}}'` after verifying the built image. For VS Code, configure the application setting `vamp.podman.desktopImageIds`. For a standalone MCP server, provide the IDs in the startup environment variable `VAMP_DESKTOP_IMAGE_IDS` (comma-separated). Screen tools reject unmanaged images, root or privileged workload settings, and writable root filesystems. Use a preview container launched read-only with the image's non-root user and no host mounts; encrypted-workspace attachment is not supported by these viewer tools yet. Start one using the recipe's [disposable smoke instructions](../containers/debian-desktop/README.md).

- **VS Code:** Open **Containers**, select the engine, then **Open Desktop** or **Capture desktop** on a running container row. The in-editor viewer is view-only. If the webview cannot establish an eligible local origin, the viewer fails closed and the snapshot remains available.
- **Standalone MCP:** `podman_view_container_screen` returns JSON containing `url`, `container_id`, `mode`, and `scope: "same_machine"`. For human keyboard/mouse control, explicitly request `mode: "control"` and obtain approval for that exact target. The AI should send the complete URL only to that requester in a private conversation, never to logs, shared chats, screenshots, or release notes. The URL is reusable during one short session with no password prompt. Open it in the browser **on the computer that runs MCP**. A remotely hosted MCP makes its own loopback URL, not the user's PC loopback. Do not broaden the bind or copy its URL to resolve that topology automatically.
- **MCP capture:** `podman_capture_container_screen` returns one verified 1920×1080 PNG for the selected desktop. Capture only at the user's request; do not capture while credentials are entered.

Local browser listeners are restricted to `127.0.0.1` and allocate the lowest open port from 6080 through 6111. Knowledge of the port is not access; the private URL contains a session capability. Browser and VS Code viewer paths are still awaiting real engine/UI testing; clipboard and file transfer are disabled in the fixed screen helper.

## Keep the workspace outside the image

| Target | Vault opens the volume | Podman must independently see |
| --- | --- | --- |
| Linux local | On the same Linux host | A verified task-only directory on the opened volume |
| Windows / WSL 2 | In Windows, or on an explicitly configured engine-side path | The intended volume and writable folder in the exact Podman machine; Windows drive visibility alone is not enough |
| Windows / Debian VM | Prefer the same Debian host that runs Podman | The verified task-only directory in that VM. Windows-only mounts are not implicitly shared |

Keep credentials and the container workspace separate. Mount only a dedicated work directory at `/workspace`; grant write access to one approved workload at a time. Do not mount the whole vault, KDBX, private key material, the host display socket, or the Podman socket in the workload. A rootless container does not eliminate file access granted by an explicit bind.

The intended order is **unlock → verify mounted identity on the engine → verify the workload binding and access → start desktop**. If a configured bind is already correct, the same container can start or restart after the volume becomes available. If the bind is new or different, prepare a reviewed replacement and preserve app state independently. Never replace a missing volume with an empty directory. Finish by saving and closing apps, stopping the workload and verifying the attachment is released, then dismounting. If any prerequisite is unverified, don't claim ready or unblock the workflow.

## MCP and UI boundary

Use **VAMP MCP** and **VAMP Vault** as the two registrations. `Open Containers` remains a VS Code view. Select an explicit rootless engine before listing containers. On native Linux, select the same-user **Local Podman** choice; Windows can still select a configured rootless SSH connection. Detection does not install or enable WSL, and listing an engine does not prove that its desktop or decrypted workspace is ready.

In **VAMP MCP**, `podman_workspace_plan` accepts only an opaque target ID and is read-only. Trusted observations must come from a host-side probe; tool callers cannot supply mount evidence. The current default is `unavailable` because that production probe is not connected. The Vault-side policy is also a source-only validator and does not alter the existing Vault unlock/dismount behavior. This phase does not perform VeraCrypt unlock, host mounts, container recreation, browser viewing or credential injection. Use only approved dummy volumes for future end-to-end testing. Vault passwords remain out of MCP tool output and out of the workload in any future mediated flow.
