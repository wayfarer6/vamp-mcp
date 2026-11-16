#!/bin/bash
set -eu
mkdir -p /etc/lightdm/lightdm.conf.d /home/vamp/.config/openbox /var/www/vamp
cat > /etc/lightdm/lightdm.conf.d/50-vamp.conf <<'EOF'
[Seat:*]
autologin-user=vamp
autologin-user-timeout=0
user-session=openbox
EOF
cat > /home/vamp/.config/openbox/autostart <<'EOF'
xset s off
xset -dpms
xrandr --output Virtual-1 --mode 1920x1080
xterm -geometry 100x28+80+80 -fa Monospace -fs 16 -title VAMP-KVM-READY &
EOF
cat > /var/www/vamp/index.html <<'EOF'
<!doctype html><html><head><title>VAMP KVM Validation</title></head><body style="font:32px sans-serif;background:#16233b;color:white;padding:50px"><h1>VAMP KVM Validation</h1><p id="status">Browser ready</p><input aria-label="Scenario text" style="font-size:32px" oninput="document.getElementById('status').textContent=this.value"><button style="font-size:32px" onclick="document.getElementById('status').textContent='CLICK VERIFIED'">Verify click</button></body></html>
EOF
cat > /etc/systemd/system/vamp-test-page.service <<'EOF'
[Unit]
Description=Local-only VAMP validation page
After=network.target
[Service]
User=vamp
WorkingDirectory=/var/www/vamp
ExecStart=/usr/bin/python3 -m http.server 8080 --bind 127.0.0.1
[Install]
WantedBy=multi-user.target
EOF
chown -R vamp:vamp /home/vamp/.config
systemctl enable vamp-test-page lightdm qemu-guest-agent
systemctl set-default graphical.target
