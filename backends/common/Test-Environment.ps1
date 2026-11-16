param([Parameter(Mandatory=$true)][string]$EnvironmentPath)
$ErrorActionPreference='Stop'
. (Join-Path $EnvironmentPath 'Scripts\Activate.ps1')
$code='import sys,os,json,importlib.metadata as m; from pathlib import Path; import mcp,robot,pycdlib,asyncvnc; expected=Path(sys.argv[1]).resolve(); assert Path(sys.prefix).resolve()==expected and sys.prefix!=sys.base_prefix; assert Path(os.environ["VIRTUAL_ENV"]).resolve()==expected; print(json.dumps({"status":"ready","activated":True,"python":sys.executable,"version":sys.version.split()[0],"packages":{n:m.version(n) for n in ["mcp","robotframework","pycdlib","asyncvnc"]}}))'
& python -c $code $EnvironmentPath
if($LASTEXITCODE -ne 0){throw 'Activated environment failed its import or interpreter check'}
