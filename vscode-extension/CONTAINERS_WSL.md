# Set up WSL 2 for Podman on Windows

This guide is for Windows 11 and the current Windows Podman installer. Use it only if you want to run Podman in WSL 2. If you already run Podman inside a Debian VirtualBox VM, use **Open Containers → Existing Debian VM** instead. You do not need to enable WSL or Hyper-V for that path. Enabling the Windows virtualization components required by WSL 2 may slow VirtualBox on some hosts.

VAMP does not activate WSL, change Windows features, restart your computer, install Podman, or change your default Podman connection. Opening this guide does none of those things.

## 1. Check whether WSL 2 is available

In PowerShell, run:

```powershell
wsl --status
wsl --list --verbose
```

If WSL 2 is already available, skip to step 3. If Windows reports that WSL is missing or that a required feature is not enabled, continue below.

## 2. Enable WSL yourself, if needed

Save your work before proceeding. Open **PowerShell as Administrator** and run:

```powershell
wsl --install --no-distribution
```

This enables the Windows features needed for WSL without installing the default Ubuntu distribution. Restart Windows if prompted. Then open a new PowerShell window and run:

```powershell
wsl --update
wsl --status
```

If `--no-distribution` isn't supported or your organization's policy blocks WSL, see [Microsoft's WSL installation instructions](https://learn.microsoft.com/windows/wsl/install) and [Podman Desktop's Windows troubleshooting guide](https://podman-desktop.io/docs/troubleshooting/troubleshooting-podman-on-windows). Some Windows 10 LTSC setups need distribution-specific instructions.

## 3. Set up a Podman machine

Choose one of these installation paths:

- **Podman CLI (no Desktop app required):** Open the [official Podman releases](https://github.com/podman-container-tools/podman/releases/latest). Under **Assets**, download `podman-installer-windows-amd64.msi` for an Intel or AMD x64 PC, or `podman-installer-windows-arm64.msi` for a Windows on Arm PC. Run the MSI, choose the per-user install if available, and select **WSL** as the machine provider, not Hyper-V. Open a new PowerShell window and run `podman --version` to check that the CLI is on your PATH. See [Podman for Windows](https://github.com/podman-container-tools/podman/blob/main/docs/tutorials/podman-for-windows.md).
- **Podman Desktop (optional GUI):** Download the Windows installer from [Podman Desktop](https://podman-desktop.io/downloads/windows). Open the app, start **Podman Setup**, select **WSL 2** as the provider, and create a Podman machine from onboarding if one does not already exist. If you use this path, skip the CLI machine creation command below.

If you installed the CLI, check the machine provider and existing machines first. If an existing rootless WSL machine already meets your needs, reuse it.

```powershell
podman machine info
podman machine list
```

To create and start a new WSL-backed Podman machine without changing the default connection:

```powershell
podman machine init --provider wsl --now --update-connection=false vamp-wsl
podman system connection list
```

If the machine already exists but is stopped, run `podman machine start --update-connection=false vamp-wsl` instead. Use the actual machine name if different.

## 4. Check the named connection in VAMP

Select the rootless connection listed by Podman. To verify it in PowerShell, replace `CONNECTION_NAME` with the listed name:

```powershell
podman --connection CONNECTION_NAME info
```

In VS Code, open **VAMP → Open Containers** and select **Detect installed Podman** to check the local Windows CLI and its existing WSL machine inventory. This does not start a machine or confirm that its Podman service is reachable.

Then select **Refresh connections**, choose your connection, and select **Test connection**. If it passes, select **Refresh containers**. In an MCP client, use `podman_connections`, `podman_check`, and `podman_list` with the same explicit connection. This integration accepts named SSH connections to rootless Podman sockets. If the WSL connection does not appear, verify its transport and rootless service before proceeding. VAMP does not change the default connection. Do not select a rootful connection or expose the Podman API over unauthenticated TCP.

See [Podman on Windows](https://podman-desktop.io/docs/installation/windows-install), [Podman machine init](https://docs.podman.io/en/latest/markdown/podman-machine-init.1.html), and [Oracle's VirtualBox troubleshooting guide](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/Troubleshooting.html).
