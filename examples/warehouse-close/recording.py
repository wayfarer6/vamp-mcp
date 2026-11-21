import pyautogui as p
import time

# Start in the prepared blank Close sheet in LibreOffice Calc.
p.hotkey("ctrl", "home")
p.press("down")
p.press("right")
p.write("${period}", interval=0.06)
p.press("enter")
p.hotkey("ctrl", "home")
p.press("down", presses=4, interval=0.10)

# A:G contain synthetic count data. H:K calculate the reconciliation.
p.write("PK-101\tPacking tape\t120\t40\t35\t123\t3000\t=C5+D5-E5\t=F5-H5\t=F5*G5\t=I5*G5", interval=0.055)
p.press("enter")
p.hotkey("ctrl", "home")
p.press("down", presses=5, interval=0.09)
p.write("LB-202\tShipping labels\t80\t60\t45\t95\t1200\t=C6+D6-E6\t=F6-H6\t=F6*G6\t=I6*G6", interval=0.055)
p.press("enter")
p.hotkey("ctrl", "home")
p.press("down", presses=6, interval=0.09)
p.write("BX-303\tCarton boxes\t210\t90\t110\t192\t2200\t=C7+D7-E7\t=F7-H7\t=F7*G7\t=I7*G7", interval=0.055)
p.press("enter")
p.hotkey("ctrl", "home")
p.press("down", presses=7, interval=0.09)
p.write("WR-404\tBubble wrap\t50\t25\t20\t54\t7500\t=C8+D8-E8\t=F8-H8\t=F8*G8\t=I8*G8", interval=0.055)
p.press("enter")

# Keep the unit price total empty. Column K is the value of the count adjustment.
p.hotkey("ctrl", "home")
p.press("down", presses=8, interval=0.08)
p.press("right", presses=2, interval=0.08)
p.write("=SUM(C5:C8)\t=SUM(D5:D8)\t=SUM(E5:E8)\t=SUM(F5:F8)\t\t=SUM(H5:H8)\t=SUM(I5:I8)\t=SUM(J5:J8)\t=SUM(K5:K8)", interval=0.055)
p.press("enter")
p.hotkey("ctrl", "home")
p.hotkey("ctrl", "shift", "s")
time.sleep(1.5)
p.hotkey("ctrl", "a")
p.write("/home/warehouse/warehouse-demo/warehouse-close-${period}.xlsx", interval=0.055)
p.press("enter")
time.sleep(2)
