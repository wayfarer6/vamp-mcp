# AI display preflight

Before recording, replaying or calculating guest coordinates, inspect the target VM's actual framebuffer. Require **1920×1080** with guest scaling **100%** for VAMP's standard recordings. A scaled screenshot or resized viewer does not verify the framebuffer.

If the resolution differs, adjust the guest to 1920×1080 using the authorized backend and guest display settings, then capture fresh evidence and verify the result before continuing. This requirement does not override a user's pause or authorize unrelated VM changes. If a driver installation, UAC approval or restart is required, identify the blocker and use the existing authorization rules.

- Linux GNOME: Settings → Displays → 1920×1080, Scale 100%, Apply. For Xorg only, inspect `xrandr --query` and select an available 1920x1080 mode. Use GNOME Settings on Wayland. Do not blindly force a missing mode.
- Windows: Settings → System → Display → Display resolution 1920×1080, Scale 100%. If unavailable, finish guest display driver/VirtualBox Guest Additions setup; verify again after any required reboot.
- VirtualBox: `vm_configure_display` can request the mode; require `observed_resolution: [1920,1080]` and `resolution_verified: true`. Independently verify guest scaling. Turn off guest auto-resize; scaled viewing does not change the target pixels.
- Other backends: inspect the native guest screenshot and session display configuration. Do not assume a VirtualBox tool works on Hyper-V or KVM.

Never reuse stale coordinates after a display change. If the target cannot be met, report the actual dimensions and block dependent coordinate replay rather than claiming success. Use the VSIX's **1920×1080 guide** for user-facing Linux and Windows instructions.
