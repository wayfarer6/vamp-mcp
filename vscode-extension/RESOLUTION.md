# Guest display: 1920×1080

**Before recording or replaying an RPA, set the VM's display to 1920×1080 at 100% scaling.** Change the guest display, not your host monitor. Resizing or zooming the viewer does not establish the guest resolution. Finish guest setup first and keep the VM awake and unlocked during setup and automation.

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
