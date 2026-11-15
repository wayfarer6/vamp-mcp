#!/usr/bin/env python3
"""Run exactly one manifest-selected Robot entrypoint; never execute every RPA."""
import argparse
import os
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from rpa_package import load_package


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('rpa',nargs='?')
    parser.add_argument('--list',action='store_true')
    parser.add_argument('--entry',help='Entrypoint name from manifest.json; defaults to run')
    parser.add_argument('--var',action='append',default=[],metavar='NAME:VALUE')
    parser.add_argument('--output',help='Robot output directory')
    parser.add_argument('--listener',action='append',default=[],help='Optional Robot listener for execution hooks')
    parser.add_argument('--dryrun',action='store_true')
    args=parser.parse_args()
    if args.list:
        for manifest_path in sorted((ROOT/'rpas').glob('*/manifest.json')):
            _,manifest=load_package(manifest_path.parent.name)
            print(f"{manifest['id']}: {manifest['name']} [{', '.join(e['name'] for e in manifest['entrypoints'])}]")
        return 0
    if not args.rpa:
        parser.error('Choose one RPA id, or use --list')
    try:
        directory,manifest=load_package(args.rpa)
    except (ValueError,FileNotFoundError) as error:
        parser.error(str(error))
    entry=args.entry or manifest['default_entrypoint']
    selected=next((e for e in manifest['entrypoints'] if e['name']==entry),None)
    if selected is None:
        parser.error(f'Unknown entrypoint: {entry}')
    # Resolve caller's output directory before establishing the repository working directory.
    default_output=ROOT/('artifacts/rpas-dryrun' if args.dryrun else 'artifacts/rpas')/args.rpa
    output=Path(args.output).resolve() if args.output else default_output
    output.mkdir(parents=True,exist_ok=True)
    (output/'summary.json').unlink(missing_ok=True)
    os.chdir(ROOT)
    from robot import run
    return run(str(directory/selected['file']),outputdir=str(output),variable=args.var,
               listener=args.listener,dryrun=args.dryrun)


if __name__=='__main__':
    raise SystemExit(main())
