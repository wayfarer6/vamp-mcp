# KVM Packer post-install host address

The current KVM image build uses the Packer **QEMU user-networking builder**.
Its guest-visible host alias is `10.0.2.2`. Deployment to `qemu:///system` happens
later and may use libvirt's separate default network. Do not substitute
`192.168.122.1` merely because the deployment target is system libvirt.

`kvm_bootstrap.resolve_kvm_bootstrap_host(request, env)` selects:

1. Explicit request `bootstrap_host`.
2. `VAMP_PACKER_BOOTSTRAP_HOST` in the builder environment.
3. QEMU user-networking default `10.0.2.2`.

An explicit empty or malformed value fails closed. The value is a plain IPv4
address, not a URL, hostname, shell expression or port. Loopback, unspecified,
multicast, link-local, reserved and non-RFC1918 addresses are rejected. An override
other than the QEMU alias must appear in the builder's read-only kernel interface
inventory (`ip -j -4 address show`), then both listeners must bind that exact
address. Missing iproute2/inventory, a nonlocal address, a removed interface or an
occupied port fails closed before osinfo/libvirt/Packer preparation. This prevents
using an override to download and execute scripts from another host. An override
still requires an already configured guest-to-local-host route; ownership is not
proof that the guest can reach it. No route, interface or firewall is changed.

## Job-owned listener scope

For default QEMU user networking, guest `10.0.2.2` maps to the builder's loopback:
script and completion listeners bind **127.0.0.1 only**. This follows libslirp's
[`sotranslate_out` alias mapping](https://qemu.googlesource.com/libslirp/+/8f1b7f3acbbbf7dd227b604875ee0d17897b7d24/socket.c),
not a guess based on the deployed libvirt subnet. A custom configuration that
blocks host-loopback access must fail; VAMP does not widen the listener to work
around it.

The worker creates a fresh job-specific script staging directory and listener
on port 8421, plus a same-address ephemeral callback listener. It never reuses a
detached server owned by another job/process. Both listeners are closed in the
worker's cleanup path. The Debian preseed HTTP listener uses the same host-side
address (loopback for the alias, otherwise the verified local override), and the
installer boot URL explicitly uses the corresponding guest-visible address.
There is **no wildcard KVM bootstrap, callback or preseed listener**. The
VirtualBox and Hyper-V branches are not changed by this KVM hardening.

For Debian KVM installs the rendered preseed late command explicitly exports:

- `VAMP_BOOTSTRAP_HOST`: the selected address
- `VAMP_SCRIPT_BASE_URL`: derived as `http://${VAMP_BOOTSTRAP_HOST}:8421`
- `VAMP_PACKER_CALLBACK`: the same host with the job-specific callback port/path

The downloaded script is staged to a `.download` path. Download success and a
non-empty body are required before replacing/executing the post-install script.
A failed/empty download cannot execute a stale previous final script. Script and
callback endpoint parsing rejects userinfo, control characters, query/fragment,
unexpected paths, mismatched hosts and shell injection before rendering.
VirtualBox's existing template is intentionally unchanged.

The shared worker/Windows post-install integration is maintained with the
Hyper-V implementation. Set the override with the MCP tool's
`bootstrap_host` field, **Packer network options** in VS Code, or the builder
environment. Check the generated preflight/request record to
confirm the selected value before starting a build.

Tests use pure address selection, mocked interface inventory/listener factories,
worker failure/cleanup fixtures, template rendering and local fake-download shell
fixtures. They perform no Packer build, VM operation, network request or
host security change. Guest reachability and Windows/Debian install completion
still require actual backend testing.
