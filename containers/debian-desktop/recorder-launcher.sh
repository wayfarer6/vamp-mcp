#!/bin/sh
set -eu
export XAUTHORITY=/tmp/vamp-desktop-runtime/Xauthority
export XDG_SESSION_TYPE=x11
export VAMP_LOCAL_RECORDINGS_DIR="$HOME/Recordings"
exec /usr/bin/python3 -I -B /opt/vamp-desktop/vamp-recorder.py
