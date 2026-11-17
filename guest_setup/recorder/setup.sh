#!/bin/sh
# Run as the guest desktop user, not root, from the mounted recorder media.
set -eu
if [ "$(id -u)" = 0 ]; then echo 'Run as the desktop user; sudo is used only for apt.' >&2; exit 1; fi
if [ "${XDG_SESSION_TYPE:-}" = wayland ]; then
  echo 'Installing on Wayland; global recording requires GNOME on Xorg after login.' >&2
fi
if [ "${RPA_DEPS_READY:-0}" != 1 ]; then
 sudo python3 "$(dirname -- "$0")/configure-debian-mirrors.py"
 sudo apt-get update
 sudo apt-get install -y build-essential python3-venv python3-tk python3-dev python3-dbus x11-xserver-utils xdg-user-dirs scrot gnome-session-xsession xserver-xorg
fi
media_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
desktop=$(xdg-user-dir DESKTOP)
[ "$desktop" != "$HOME" ] || desktop="$HOME/Desktop"
[ -n "$desktop" ] || desktop="$HOME/Desktop"
folder="$desktop/RPA-Recorder"
mkdir -p "$folder/recordings"
# Refuse to replace an existing recorder; keep user changes and recordings.
if [ ! -f "$folder/PyAutoGuiRecorder.py" ]; then
  # The bundle ships beside this script. When it is missing (a lone download of
  # setup.sh on a clean host), fetch the same bundle from the project repository.
  recorder_zip="$media_dir/recorder.zip"
  if [ ! -f "$recorder_zip" ]; then
    recorder_zip="$folder/recorder.zip"
    url='https://raw.githubusercontent.com/wayfarer6/vamp-mcp/main/guest_setup/recorder/recorder.zip'
    echo "recorder.zip is not beside setup.sh; downloading it from $url" >&2
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$url" -o "$recorder_zip"
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$recorder_zip" "$url"
    else
      echo 'curl or wget is required to download the recorder bundle.' >&2
      exit 1
    fi
  fi
  python3 -m zipfile -e "$recorder_zip" "$folder"
  [ "$recorder_zip" = "$media_dir/recorder.zip" ] || rm -f "$recorder_zip"
fi
cp "$media_dir/prepare-recording.py" "$media_dir/RECORDING-GUIDE.txt" "$media_dir/vamp-recorder.py" "$media_dir/RECORDER-LICENSE" "$folder/"
python3 "$media_dir/install-display-startup.py"
dbus-run-session -- python3 "$media_dir/session-policy.py"
python3 -m venv "$folder/.venv"
"$folder/.venv/bin/python" -m pip install -r "$media_dir/requirements-recorder.txt"
cat > "$folder/start-recorder.sh" <<'LAUNCH'
#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
exec .venv/bin/python vamp-recorder.py
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
