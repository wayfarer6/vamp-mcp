# Optional GPU image recipes

These are **unbuilt, unverified future-use recipes**. They extend the same desktop image and do not change its non-root runtime, fixed screen or noVNC listener policy. They do not install host drivers, enable WSL, grant hardware access, or switch users into GPU mode automatically.

From this directory, first build the common image, then build either derivative:

```sh
podman build -t localhost/vamp-debian-desktop:dev -f Containerfile .
podman build --pull=never -t localhost/vamp-debian-desktop:nvidia -f Containerfile.nvidia .
podman build --pull=never -t localhost/vamp-debian-desktop:amd -f Containerfile.amd .
```

The same Containerfiles can be used with Docker on an appropriately configured host. Record the verified common image digest and pin it via `VAMP_DESKTOP_BASE` before publishing a derivative.

| Recipe | Inside the image | On the engine host, independently configured |
| --- | --- | --- |
| NVIDIA | GLVND, EGL/OpenGL and Vulkan diagnostic utilities | Supported NVIDIA driver and NVIDIA Container Toolkit with CDI. Explicitly select the single approved GPU by CDI name. |
| AMD | Debian Mesa DRI/Vulkan/VA-API graphics libraries and diagnostics | Supported kernel GPU driver, firmware and permission to the specific render node for the intended AMD GPU. Pass only that approved render node to rootless Podman. |

Host permissions are requirements, not a reason to make the container privileged, expose all devices, grant broad groups, or disable SELinux/AppArmor or Chromium sandboxing. The recipes do not include the CUDA or ROCm development runtimes. Linux, a Windows WSL 2 machine, and a VirtualBox guest expose different GPU capabilities; verify the selected **engine host** first, and do not assume passthrough works for any of them.

The Xvfb framebuffer remains a software virtual display at 1920×1080. A device being visible does not prove XFCE, Chromium, LibreOffice or the noVNC view renders on it. Confirm a target workload selects the hardware driver (not a software renderer), and test browser/session acceleration separately before announcing support.

References: [NVIDIA CDI](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html), [Podman device support](https://docs.podman.io/en/latest/markdown/podman-run.1.html#device-host-device-container-device-permissions), [Debian Mesa Vulkan drivers](https://packages.debian.org/trixie/mesa-vulkan-drivers).
