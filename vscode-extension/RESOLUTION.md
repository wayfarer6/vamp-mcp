# Guest display: 1920×1080

**Before recording or replaying an RPA, set the VM's display to 1920×1080 at 100% scaling.** Change the guest display, not your host monitor. Resizing or zooming the viewer does not establish the guest resolution. Finish guest setup first and keep the VM awake and unlocked during setup and automation.

## Reset shortcuts installed by guest setup

- **Windows Desktop:** double-click `Set-Resolution-1920x1080.cmd`. It opens the companion PowerShell script and applies Full HD. Press any key to close its result window.
- **Debian home folder:** open a terminal in the logged-in guest and run `~/set-resolution-1920x1080.sh`.

Run these inside the VM when the display drifts. They reuse the same display helper as the per-login hook, apply 1920x1080 and report the observed result. They do not resize the host screen. If the guest driver rejects Full HD, the script reports that failure; finish the guest display driver setup first. All shortcut instructions and messages are in English.


## Linux VM — Debian / Ubuntu GNOME

1. Inside the guest, open **Settings → Displays**.
2. Select the guest display, choose **1920 × 1080**, and set **Scale** to **100%**.
3. Apply the settings and keep the changes. Recheck after login or reconnecting the viewer.

If you use **GNOME on Xorg**, you can list available modes and select an existing Full HD mode in the guest terminal:

```sh
xrandr --query
display=$(xrandr --query | awk '/ connected/{print $1; exit}')
xrandr --output "$display" --mode 1920x1080
```

Run this as the logged-in desktop user, not on the host. `xrandr` is an Xorg tool; in a Wayland session use Settings → Displays. If 1920×1080 is missing, finish the display driver/Guest Additions setup and reboot when installation is complete. Do not force an unavailable mode. In GNOME, the login screen's session menu may offer **GNOME on Xorg** if installed.

For VirtualBox, keep **Auto-resize Guest Display** off after setting the target resolution. Use **View → Scaled Mode** to fit the viewer without changing guest pixels. On KVM, check the guest display driver and configured virtual video device if the mode is unavailable.

## Windows VM — Windows 11

1. Inside the guest, open **Start → Settings → System → Display**.
2. Under **Scale & layout**, choose **Display resolution: 1920 × 1080** and **Scale: 100%**.
3. Keep the changes. If Windows requests a sign-out, finish setup before signing out, then verify the settings again.

If the resolution is missing or disabled in VirtualBox, finish guest setup, choose **Devices → Insert Guest Additions CD image**, open the CD inside Windows and run **VBoxWindowsAdditions.exe**. Approve the guest UAC prompt and reboot after installation. Then select 1920×1080 and 100% again. Leave **Auto-resize Guest Display** off; **Scaled Mode** changes only the viewer presentation.

Hyper-V basic sessions can expose fewer display modes. Use supported guest display drivers or an Enhanced Session when available, set the session display to 1920×1080, and recheck the effective guest resolution after reconnecting. The VAMP Hyper-V embedded viewer is not implemented.

## Verify before automation

Check the actual guest screen dimensions, not a resized preview. For VirtualBox, `vm_screen_info` / a native screenshot can report the framebuffer size. `vm_configure_display` requests Full HD and returns `observed_resolution` and `resolution_verified`; a sent hint is not proof of a changed resolution. Verify 100% scaling separately inside the guest.

An RPA recorded at another resolution needs recalibration or a matching recording. If the guest cannot reach 1920×1080, report the observed resolution and resolve the display driver/session issue before coordinate-based replay.

References: [GNOME display settings](https://teams.pages.gitlab.gnome.org/websites/help.gnome.org/gnome-help/look-resolution.html), [Microsoft display resolution and layout](https://support.microsoft.com/en-us/windows/hardware/display-graphics/change-your-screen-resolution-and-layout-in-windows).

Windows guest setup and display-reset scripts request administrator PowerShell when needed. Approve the UAC prompt. The elevated process runs `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Unrestricted -Force` before the script. MCP and VSIX share the same Ctrl+Shift+Enter / UAC Left+Enter bootstrap. Script execution policy changes apply to that process.

Windows setup finishes with an elevated direct registry update to 1920x1080 (`PrimSurfSize.cx/cy` and `ActiveSize.cx/cy`) for the guest display configurations, on VirtualBox, KVM and Hyper-V. The Desktop reset script performs the same update before applying the display mode. Previous registry values are backed up under `%ProgramData%\VAMP\display-registry\backups`. A compatible guest display driver is still required.
