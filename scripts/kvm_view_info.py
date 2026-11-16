#!/usr/bin/env python3
"""Read VM viewer endpoints, independent of an AI/MCP client."""
import argparse
import json
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from mcp_vm.controller import VMController

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--config');p.add_argument('--list',action='store_true');p.add_argument('--vm');a=p.parse_args();c=VMController(a.config)
    try:result=c.list_vms() if a.list else c.viewer_info(a.vm)
    except (ValueError,RuntimeError,OSError) as error:
        print(json.dumps({'status':'error','error_summary':str(error)[:300]}));sys.exit(1)
    print(json.dumps(result))
