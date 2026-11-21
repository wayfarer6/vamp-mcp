import os
import tkinter as tk
from pathlib import Path

import pyautogui
from PIL import ImageGrab


def verify_gui(artifact):
    root = tk.Tk()
    try:
        root.geometry("420x230+100+100")
        entry = tk.Entry(root)
        entry.pack()
        root.update()
        entry.focus_force()
        root.update()
        expected = "VAMP WSL GUI check"
        pyautogui.write(expected, interval=0.035)
        root.update()
        if entry.get() != expected:
            raise AssertionError("The headless desktop did not deliver keyboard input.")
        if tuple(pyautogui.size()) != (1920, 1080):
            raise AssertionError("Unexpected virtual display resolution.")
        if os.environ.get("VAMP_WSL_VISION") == "gpu":
            ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).save(Path(artifact).with_suffix(".png"))
        Path(artifact).write_text(expected + "\n", encoding="utf-8")
    finally:
        root.destroy()
