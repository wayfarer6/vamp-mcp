#!/usr/bin/env python3
"""Generate a Robot/SPICE package from a literal PyAutoGUI recorder source."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from recording_converter import main

if __name__=='__main__':
    main()
