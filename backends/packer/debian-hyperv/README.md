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
