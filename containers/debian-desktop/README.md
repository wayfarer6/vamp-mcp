# VAMP Debian OCI desktop: phase 1

**Source implementation, not a verified built image.** This directory is separate
from the Debian Podman-host VM image and from existing Windows/Debian VM profiles.
It adds no MCP registrations and does not change VAMP Vault.

## Included by default

- `debian:trixie-slim`, minimal XFCE desktop and terminal/file manager
- Debian Chromium, with its sandbox enabled
- LibreOffice Writer, Calc and Impress
- Noto CJK (including Korean), emoji and Liberation fonts
- Xvfb: one **1920×1080, 24-bit** screen, measured with `xdpyinfo`
- Official Debian `novnc`, `websockify` and `x11vnc` packages, installed but **not listening**

No GNOME, password vault, disk encryption utility, SSH daemon, sudo, default
login password, baked access token, host X server or mounted engine socket is
required. The image runs as UID/GID 1000 (`desktop`), not root. Its account is
password-locked. Image construction uses package installation privileges inside
the build image; runtime does not elevate. SUID/SGID bits are removed from the
image, and no Chromium setuid helper is installed.

## Desktop and readiness

The fixed entrypoint starts Xvfb with `-nolisten tcp` and a fresh random Xauthority
cookie on a private container-local Unix socket. The cookie is sent to `xauth`
on stdin, stored mode 0600 in a mode 0700 runtime directory and is never printed.
It then starts `dbus-run-session -- xfce4-session --disable-tcp`. It does not start
x11vnc, websockify or another network viewer.

A supervisor verifies the **actual framebuffer**, including screen count and
root depth, at startup and every two seconds. An incorrect resolution/depth or
terminated session removes readiness, terminates supervised children and exits
with an error. A separate OCI healthcheck remeasures the framebuffer. A healthy
framebuffer does **not** assert that browser/Office operation or an interactive
viewer has been tested. Resizing a future viewer will not change this contract.

The runtime refuses root execution, an alternate host `DISPLAY`, a mounted host
X11 socket directory and the conventional Docker/Podman host engine socket paths.
These guards are not a substitute for a correctly configured rootless container:
do not mount host displays, host device trees, engine sockets, secrets or arbitrary
host directories, including under alternative names.

## Chromium sandbox

The supported launcher is `/usr/local/bin/vamp-chromium`. It adds no sandbox
bypass flags and rejects known disabling flags. The image relies on Chromium's
unprivileged user-namespace sandbox, not a setuid escalation helper. Namespace
availability depends on the actual host/engine sandbox. If Chromium cannot start
its sandbox, report the host incompatibility; **do not** add `--no-sandbox`, run
privileged, disable seccomp/SELinux/AppArmor or change host security settings to
make this image appear tested. Chromium may therefore remain blocked on some
rootless environments until a supported host configuration is independently
available. Browser sandbox operation has not yet been verified for this image.

## Viewer boundary, including WSL

noVNC and websockify are present even when the engine runs in WSL. They are not
started automatically. The image exposes **no listener, no published port and no
VNC password**. Access is only through explicitly invoked fixed helpers:

- `/usr/bin/python3 -I -B /opt/vamp-desktop/capture.py`: emits exactly one
  1920×1080 PNG to stdout, no screenshot file. It verifies desktop readiness
  before and after capture, uses Debian `xwd | xwdtopnm | pnmtopng -force` through
  fixed argument arrays (not a shell), enforces an 8 MiB output cap and a
  10-second conversion deadline, and validates the PNG signature, dimensions,
  CRCs, full decoded scanline length and single-frame termination. Readiness
  probes can add up to three seconds each. Failure emits only a generic stderr
  message and never partial PNG output.
- `/usr/bin/python3 -I -B /opt/vamp-desktop/view.py`: one **view-only** RFB session
  on inherited stdin/stdout. It gives `x11vnc -inetd` a connected AF_UNIX
  socketpair and relays it to the outer pipes, avoiding versions that expect an
  actual socket rather than raw pipe descriptors. There is no TCP bind/listen.
  With no arguments the RFB server itself enforces `-viewonly`; clipboard/primary selection,
  file-transfer extensions, user rc files, remote-control commands and external
  command hooks are disabled. Queues are bounded to 1 MiB per direction, setup
  timeout is 30 seconds, total session limit is one hour and desktop readiness
  is rechecked every five seconds. EOF or revocation tears the child down.

Capture accepts **no arguments**. Viewer accepts exactly **no arguments**
(view-only) or exactly **one `--interactive` flag** (human control). All other
flags, duplicate flags and extra arguments are rejected; no argument is forwarded
to x11vnc. The interactive branch removes only the fixed `-viewonly` flag and
leaves clipboard/file-transfer restrictions, rc/hook restrictions, the private
socketpair transport, readiness checks and timeouts intact.

`--interactive` is reserved for the standalone MCP desktop link after the host
browser pairing/authorization step has completed for that session. It enables the
**human browser user's** keyboard and mouse through RFB, not an AI arbitrary-input
or exec tool. The image helper cannot independently verify browser pairing; the
managed host adapter must enforce that boundary before launching it. Never use
this mode based on a tool argument alone or forward a caller-selected mode through
an unauthenticated endpoint. The VS Code viewer continues to invoke no-argument,
server-enforced view-only mode.

Both helpers require UID 1000 and private local display authority, and load only
root-owned image sibling modules under isolated Python.
Tool stderr, environment and Xauthority contents are never sent to the viewer or
MCP. Neither helper receives or stores a login password or viewer token.

RFB security inside the private inherited pipe is not browser authentication.
The managed **Open Desktop** wrapper must authenticate before launching the
helper, bind the session to an inspected allowlisted immutable image and selected
container, check WebSocket origin, restrict its outer endpoint to controlled
loopback and revoke the helper when the session closes. Loopback alone is not
authentication. Do not expose this stream through a generic TCP relay or WSL
port-forward, and do not launch it directly for an untrusted caller. Human control is available only through the explicitly paired interactive branch;
AI input injection is not provided. Live noVNC→Podman→AF_UNIX→x11vnc
compatibility remains unverified until an authorized image/runtime test.

## Build and smoke procedure (not executed here)

Use an existing non-root Podman installation with working subordinate UID/GID
mappings. Confirm `podman info --format '{{.Host.Security.Rootless}}'` returns
`true`. These example commands are for an independently authorized disposable
sandbox, not the owner's current Windows environment:

```sh
podman build -t localhost/vamp-debian-desktop:phase1 containers/debian-desktop
podman run --rm --name vamp-desktop-smoke \
  --read-only --network=none --cap-drop=all --security-opt=no-new-privileges \
  --mount type=tmpfs,destination=/home/desktop,tmpfs-mode=0700,nosuid,nodev,U=true \
  --pids-limit=512 --memory=3g --cpus=2 --shm-size=512m \
  localhost/vamp-debian-desktop:phase1
```

There are no ports or host volume mounts in this example. It is intentionally
network-isolated for a first framebuffer/application startup smoke test, not web
browsing. Do not attach existing user volumes for verification. In a second
terminal, an authorized `podman healthcheck run vamp-desktop-smoke` should verify
1920×1080×24. A container healthcheck is not a screenshot or application result.
Stop this newly created disposable container when finished; do not remove or
alter existing containers/volumes. Engine-specific Chromium namespace support
must still be established without weakening host/container security.

The base tag and Debian security packages are intentionally not asserted to be a
reproducible artifact. A release should record the verified base digest and package
versions after a successful authorized build, plus actual sandbox/application
smoke evidence for the intended architecture and engine.

## Tests and limitations

Run the isolated source fixtures:

```sh
python -I -B -m unittest discover -s containers/debian-desktop/tests -p 'test_*.py'
```

They check package/non-root declarations, framebuffer parsing, depth/count/drift
rejection, supervised cleanup with mocked processes, cookie handling, sandbox
flag rejection, PNG validation, fixed helper arguments and a real local AF_UNIX
socketpair/pipe relay against an injected fake child. They never run Xvfb,
x11vnc, Chromium, Office, Podman or Docker.

At implementation time the cloud workspace had **neither Podman nor Docker**.
No engine was installed and no host security setting was changed. Therefore the
OCI build, actual XFCE session, Chromium sandbox, Writer/Calc/Impress rendering,
Korean font output, real framebuffer after restart and secure Open Desktop
interaction remain **unverified**. No image was pushed.

References: [Debian noVNC](https://packages.debian.org/trixie/web/novnc),
[Debian Xvfb](https://packages.debian.org/stable/xvfb),
[XFCE session options](https://manpages.debian.org/trixie/xfce4-session/xfce4-session.1.en.html),
[Chromium Linux sandbox design](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/sandbox/linux).

Transport references: [Debian x11vnc manual](https://manpages.debian.org/trixie/x11vnc/x11vnc.1.en.html)
(`-inetd`, `-viewonly`, `-norc`, `-safer`, `-nocmds`, clipboard options),
[Debian screenshot pipeline](https://wiki.debian.org/ScreenShots),
[Netpbm PNG converter](https://netpbm.sourceforge.net/doc/pnmtopng.html).
