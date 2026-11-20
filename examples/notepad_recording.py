"""Synthetic PyAutoGUI recording for a Windows guest."""

import pyautogui

pyautogui.hotkey("win", "r")
pyautogui.sleep(1)
pyautogui.write("notepad")
pyautogui.press("enter")
pyautogui.sleep(2)
