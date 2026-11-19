#!/usr/bin/env python3
"""Manage detached model workers: start/status/stop/restart, without systemd."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from model_daemon import KINDS,ensure_services,runtime_dir,status,stop


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['start','status','stop','restart'])
    parser.add_argument('--device',default='auto')
    parser.add_argument('--no-wait',action='store_true',help='Start workers without waiting for model preload')
    parser.add_argument('--kind',choices=KINDS,help='Manage only one worker')
    args=parser.parse_args()
    kinds = (args.kind,) if args.kind else KINDS
    if args.action in ('stop','restart'):
        states={kind:stop(kind) for kind in kinds}
    if args.action=='restart' and any(state.get('running') for state in states.values()):
        raise RuntimeError('A worker is still stopping; wait for current inference before restart')
    if args.action in ('start','restart'):
        states=ensure_services(wait=not args.no_wait,device=args.device,kinds=kinds)
    if args.action=='status':states={kind:status(kind) for kind in kinds}
    print(json.dumps({'runtime_directory':str(runtime_dir()),'services':states},indent=2))


if __name__=='__main__':main()
