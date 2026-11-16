#!/usr/bin/env python3
"""Move the guest USB tablet through the matching VirtualBox SDK, without clicking."""
import argparse

def move(vm, x, y):
    if x < 0 or y < 0: raise ValueError('Guest coordinates must be non-negative')
    from vboxapi import VirtualBoxManager
    manager=VirtualBoxManager(None,None)
    vbox=manager.getVirtualBox();session=manager.getSessionObject(vbox)
    vbox.findMachine(vm).lockMachine(session,manager.constants.LockType_Shared)
    try:
        mouse=session.console.mouse
        if not mouse.absoluteSupported:raise RuntimeError('Guest has no absolute pointing device')
        mouse.putMouseEventAbsolute(x+1,y+1,0,0,0)
    finally:session.unlockMachine()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('vm');p.add_argument('x',type=int);p.add_argument('y',type=int);a=p.parse_args();move(a.vm,a.x,a.y)
