#!/bin/sh
# Run as the guest desktop user, not root, from the mounted recorder media.
set -eu
if [ "$(id -u)" = 0 ]; then echo 'Run as the desktop user; sudo is used only for apt.' >&2; exit 1; fi
if [ "${XDG_SESSION_TYPE:-}" = wayland ]; then
  echo 'Recorder requires an X11 desktop session. Log out and choose GNOME on Xorg.' >&2
  exit 1
fi
if [ "${RPA_DEPS_READY:-0}" != 1 ]; then
 sudo apt-get update
 sudo apt-get install -y python3-venv python3-tk python3-dev xdg-user-dirs scrot
fi
media_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
desktop=$(xdg-user-dir DESKTOP)
[ "$desktop" != "$HOME" ] || desktop="$HOME/Desktop"
[ -n "$desktop" ] || desktop="$HOME/Desktop"
folder="$desktop/RPA-Recorder"
mkdir -p "$folder/recordings"
# Refuse to replace an existing recorder; keep user changes and recordings.
if [ ! -f "$folder/PyAutoGuiRecorder.py" ]; then
 python3 -m zipfile -e "$media_dir/recorder.zip" "$folder"
fi
python3 -m venv "$folder/.venv"
"$folder/.venv/bin/python" -m pip install -r "$media_dir/requirements-recorder.txt"
cat > "$folder/start-recorder.sh" <<'LAUNCH'
#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
exec .venv/bin/python PyAutoGuiRecorder.py
LAUNCH
chmod +x "$folder/start-recorder.sh"
cat > "$desktop/RPA-Recorder.desktop" <<LAUNCH
[Desktop Entry]
Type=Application
Name=RPA Recorder
Exec=\"$folder/start-recorder.sh\"
Path=$folder
Terminal=false
LAUNCH
chmod +x "$desktop/RPA-Recorder.desktop"
printf 'Recorder installed: %s\n' "$folder"
echo 'Launch start-recorder.sh in the folder. Save recordings under recordings/. Do not record passwords.'
