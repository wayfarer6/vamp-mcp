# Debian 13 on Hyper-V

Run Packer and Vagrant from an elevated Windows PowerShell. Install Python with
`pycdlib`, Packer with its Hyper-V plugin, and Vagrant. Use the official Debian
13 amd64 DVD-1 and the SHA-256 from Debian's signed checksum list.
DVD-1 does not contain `hyperv-daemons`. On a Debian 13 system using the
official APT repositories, run `apt-get download hyperv-daemons=<version>`.
Use the SHA256 field for that version from `apt-cache show hyperv-daemons`.
The generator verifies the package and adds it to the answer ISO for offline
installation. The daemon lets Hyper-V report the guest address to Vagrant.

Use one job directory, SSH key, VM name and reserved static address per box.
Use an internal Hyper-V switch with WinNAT, a host gateway on that subnet, and
an address excluded from DHCP pools. The generator reserves the address in
`~/.vamp/hyperv-debian-addresses` and rejects duplicate claims from this host
account. Check addresses managed by other accounts or systems before use.
After destroying a deployment and retiring its box, the operator can remove
the corresponding reservation file. The build itself uses the DVD and answer
ISO, and brings up the network only on the installed system.

### VAMP VM Manager and MCP

For **Create and Start**, set `VAMP_HYPERV_DEBIAN_CONFIG` to an absolute path
to a local JSON profile before launching the elevated VS Code instance. The
same profile can be passed as `hyperv_debian` to the MCP `vm_create` tool.
Use one profile and reserved guest IP per deployment. The selected ISO must
match the signed Debian DVD checksum.

On Windows, standalone `vamp-mcp` requests UAC at startup when the local
unified VM server is launched from a standard session. Approve the Windows
prompt to let the administrator process connect back to the MCP client.
For VAMP Tools in VS Code, open VS Code with **Run as administrator**. A
standard Windows VS Code session cannot start the local VM MCP.

```json
{
  "switch": "VAMP-Debian-Install",
  "guest_ip": "192.168.100.51/24",
  "gateway": "192.168.100.1",
  "dns": "1.1.1.1",
  "dvd_sha256": "<64 hexadecimal digits>",
  "ssh_private_key": "C:/keys/debian-hyperv-51",
  "hyperv_daemons_deb": "C:/vamp-inputs/hyperv-daemons.deb",
  "hyperv_daemons_sha256": "<64 hexadecimal digits>"
}
```

VAMP publishes the golden export separately from the VM disk and marks the
job complete after Vagrant provisioning, reload, and a successful SSH check
of the setup marker. The desktop provisioning stage needs access to the Debian
mirror through the configured switch and gateway. Inspect the stage and the
Packer log in **Golden Images** when a job fails.
The deployed VM's Vagrant configuration and provisioning files remain in its
live directory. Run Vagrant from that directory with the configured SSH key
available when managing the VM after the golden export is removed.

### Diagnose an installer or network failure

If an older build stops at the Default Switch DHCP or network preseed screen,
create a new build using the dedicated internal switch and static profile
above. The offline installer reads its answer file from the attached ISO.

| Golden Images stage | What to check |
| --- | --- |
| `static_network_preflight` | Confirm the selected switch is internal and its Windows adapter has the configured gateway and subnet prefix. |
| `offline_answer_media` | Check the DVD and daemon package SHA-256 values, the job directory, and the SSH public key. |
| `offline_install` | Inspect the guest console and Packer log for DVD, answer-media, or installer errors. |
| `static_ip_provisioning` | Check the reserved IPv4 address, WinNAT gateway, and the Debian mirror connection used by Vagrant. |
| `verify_static_ip_after_reboot` | Check SSH at the reserved address and the guest setup marker. |

Keep the golden export and live VM directories separate. When removing a
failed or retired deployment, select the live VM in the VM manager and verify
the golden image is still listed before cleaning up build files.

### Standalone build

```powershell
$job = 'C:/vamp-builds/debian-hyperv-51'
$env:VAMP_DEBIAN_HYPERV_SSH_KEY = 'C:/keys/debian-hyperv-51'
$env:VAMP_DEBIAN_HYPERV_JOB = $job
python prepare.py --dvd $dvd --dvd-sha256 $verifiedSha256 --job-dir $job `
  --vm-name Vamp-Debian-51 --switch VAMP-Debian-Install `
  --guest-ip 192.168.100.51/24 --gateway 192.168.100.1 --dns 1.1.1.1 `
  --ssh-public-key "$env:VAMP_DEBIAN_HYPERV_SSH_KEY.pub" `
  --hyperv-daemons-deb $hypervDeb --hyperv-daemons-sha256 $hypervDebSha256
packer init debian.pkr.hcl
packer build "-var-file=$job/build.pkrvars.json" debian.pkr.hcl
python package_box.py $job
$env:VAGRANT_DOTFILE_PATH = "$job/.vagrant"
vagrant validate
vagrant up --provider=hyperv
vagrant reload
```

APT mirror and recorder installation run over SSH after first boot through
Vagrant provisioning. A successful provision writes
`/var/lib/vamp/guest-setup.complete`. After Vagrant reload, verify SSH over the
same address and confirm GNOME on Xorg before recording a harmless test action.
Keep the box, answer media, private SSH key, and test recordings outside Git.

## GUI-free base for Podman

The same Packer template exports a GUI-free Debian box. Select the headless
Vagrant profile before the first `vagrant up` of a fresh deployment:

```powershell
$env:VAMP_DEBIAN_HYPERV_PROFILE = 'headless'
vagrant up --provider=hyperv
```

This profile configures Debian package mirrors and checks APT connectivity.
Set `VAMP_DEBIAN_HYPERV_PROFILE=podman` to also install a rootless engine
in the GUI-free VM. The dedicated `vamp` account uses the job's deployment
SSH key and a lingering user socket. Provisioning prints the socket path.

Verify the VM's SSH host key through the console before accepting it on the host.
Then add a named Podman connection using the address and the reported socket:

```powershell
podman system connection add --identity $env:VAMP_DEBIAN_HYPERV_SSH_KEY vamp-hyperv `
  ssh://vamp@192.168.100.51/run/user/1001/podman/podman.sock
podman --connection vamp-hyperv info --format '{{.Host.Security.Rootless}}'
```

Select that connection in VAMP MCP or **Open Containers**. Use a new job and
reserved address for each deployment.
