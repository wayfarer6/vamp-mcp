# Debian headless Podman: source-only sibling profile

This is **not integrated with the desktop runner, VS Code create action or MCP
create action**. Those paths remain unchanged. No box has been built or booted
by this change. Generated `profile.json` explicitly says
`source_only_unverified` and `box_created: false`; a planned filename is not an
artifact or a successful deployment.

The pure Python `profile.py:render_profile` API accepts a **new** output directory
and keyword arguments:

- `provider`: `virtualbox` or `kvm` (Vagrant provider `libvirt`)
- `iso_url`: official Debian amd64 installer HTTPS URL; caller must choose and
  independently verify the Debian release and ISO signature/checksum
- `iso_checksum`: `sha256:` followed by 64 hexadecimal digits; never `none`
- `build_public_key`: temporary caller-generated plain public key, no comment
- `ssh_private_key_file`: corresponding external host path, never read or copied
- `deployment_public_key`: separate caller public key, no comment

The renderer only writes inputs. It does not download, install dependencies,
spawn tools, build a VM or configure a host. Review generated files before a
separately authorized `packer init`, `packer validate`, then `packer build` on
`podman.pkr.hcl`. Actual plugin resolution/HCL validation is pending. Do not run
`provision.sh` on a host: it is a guest-only provisioning script.

## Build and deployment contract

Debian uses BIOS installer boot commands, no graphical tasks, key-only SSH and a
locked-password `vamp` account. Installer boot menu compatibility, locked-password
SSH/PAM behavior and unattended install completion must be tested against the
chosen ISO. Preseed travels over Packer's temporary HTTP server: build only on a
trusted isolated build network; restrict host firewall access to the builder as
needed. This profile does not make firewall changes.

Temporary passwordless sudo exists only during image construction. Final shutdown
replaces the temporary build public key with the deployment public key, removes
the build sudoers entry, installer logs, SSH host keys and machine identity.
Per-VM SSH host keys regenerate before SSH on first boot. Verify this on two
independently deployed VMs before treating the box as reusable. A failed build
must not be published or handed off as a ready box.

Podman runs rootless as `vamp`, with a lingering user manager and its user
`podman.socket`. Its Unix socket is `/run/user/<guest-uid>/podman/podman.sock`.
Use SSH as `vamp` with the deployment private key to access the API. There is no
TCP API, desktop, GNOME, recorder, GUI autologin, Docker group or WSL activation.
UID/subuid mapping, socket persistence and Podman operation require actual guest
verification. Socket access gives full control over this user's containers.

The HashiCorp Vagrant postprocessor emits one separate box for each provider:

- VirtualBox: `debian-podman-virtualbox.box`
- QEMU/KVM: `debian-podman-libvirt.box`

These boxes are not interchangeable. Build on a suitable host (VirtualBox host
or Linux KVM host); KVM/libvirt on Windows is not enabled by this profile. No
Guest Additions/shared folders are required. The Vagrant handoff must disable
synced folders and privileged provisioning, use `ssh.username = "vamp"`, an
external matching deployment private-key path and `ssh.insert_key = false`.
See `backends/vagrant/podman_handoff.py` for the separate source-only handoff. No built-in
Vagrant insecure key is authorized.

After an authorized build finishes, verify the local box SHA-256, inspect the
archive's metadata and any embedded Vagrantfile as data, then call
`render_vagrantfile` with the matching provider, local box, reviewed metadata,
and external deployment key. Save the returned file as `Vagrantfile` in a new
project directory. Then manually run `vagrant validate`, followed by either
`vagrant up --provider=virtualbox` or `vagrant up --provider=libvirt` on the
matching host. Vagrant and its provider must already be installed; the KVM path
requires the `vagrant-libvirt` plugin. No box is built or booted from the VAMP
Containers panel.

After the guest is running, use `vagrant ssh-config` to identify its SSH address,
port and username, and verify the guest's SSH host fingerprint independently
before setting up a named Podman connection. Use the guest's actual numeric UID
in the rootless socket path rather than assuming a fixed UID. Keep the connection
name explicit; do not replace the default connection for other projects.

**A box containing your deployment public key is private-per-user, not a public
base image. Do not distribute it or its build directory publicly.** No private
keys or fixed login passwords are copied into the guest or generated files.
Keep the temporary private build key outside the output tree and revoke/delete
it after successful verification. Local box checksum/trust and provider metadata
must be checked independently before Vagrant import.

## Verification still required

Packer HCL/plugin validation, both fresh ISO builds, Vagrant import/start/reboot
on each provider, distinct host identities, key-only login, removal of temporary
builder authorization/sudo, persistent rootless socket and a container smoke
test are **not yet performed**. Packaging is not evidence these passed.

Design references: [VirtualBox ISO builder](https://developer.hashicorp.com/packer/integrations/hashicorp/virtualbox/latest/components/builder/iso),
[QEMU builder](https://developer.hashicorp.com/packer/integrations/hashicorp/qemu/latest/components/builder/qemu),
[Vagrant postprocessor](https://developer.hashicorp.com/packer/integrations/hashicorp/vagrant/latest/components/post-processor/vagrant).
