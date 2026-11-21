#!/usr/bin/env python3
"""Check release builds without extracting or publishing archives."""

import hashlib
import json
import os
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def manifest(directory):
    return json.loads((ROOT / directory / "package.json").read_text(encoding="utf-8"))


def check(condition, reason):
    if not condition:
        raise ValueError(reason)


def verify(output):
    files = []
    for mcp_dir, vsix_dir, server in (
        ("npm-package", "vscode-extension", "unified"),
        ("npm-packages/vault", "vscode-vault-extension", "vault"),
    ):
        mcp, vsix = manifest(mcp_dir), manifest(vsix_dir)
        version = mcp["version"]
        check(vsix["version"] == version, f"{mcp_dir} and {vsix_dir} versions differ")
        if server == "unified" and os.environ.get("GITHUB_REF_TYPE") == "tag":
            check(os.environ.get("GITHUB_REF_NAME") == f"v{version}", "Tag does not match VAMP package version")

        tgz_path = output / f'{mcp["name"]}-{version}.tgz'
        vsix_path = output / f'{vsix["name"]}-{version}.vsix'
        runtime = f"runtime/backends/{server}/server.mjs"
        with tarfile.open(tgz_path, "r:gz") as tgz:
            with tgz.extractfile("package/package.json") as stream:
                package = json.load(stream)
            for key in ("name", "version", "bin"):
                check(package[key] == mcp[key], f"{tgz_path.name} has wrong {key}")
            for entry in [runtime, *mcp["bin"].values()]:
                check(tgz.getmember("package/" + entry).isfile(), f"{tgz_path.name} is missing {entry}")
            if server == "unified":
                with tgz.extractfile("package/runtime/provisioning-assets.json") as stream:
                    split = json.load(stream)
                provision = output / "provisioning" / f"vamp-assets-v{version}.tar.gz"
                checksum_line = f"{sha256(provision)}  {provision.name}"
                check(split == {"version": version, "sha256": checksum_line.split()[0]}, "Package has wrong provisioning metadata")
                check((provision.parent / "SHA256SUMS").read_text(encoding="utf-8").strip() == checksum_line,
                      "Provisioning checksum does not match")
                files.append(provision)

        with zipfile.ZipFile(vsix_path) as archive:
            corrupt_entry = archive.testzip()
            check(corrupt_entry is None, f"{vsix_path.name} has a bad ZIP entry: {corrupt_entry}")
            package = json.loads(archive.read("extension/package.json"))
            for key in ("name", "publisher", "version", "main"):
                check(package[key] == vsix[key], f"{vsix_path.name} has wrong {key}")
            for entry in ["extension.vsixmanifest", "extension/" + package["main"].removeprefix("./"),
                          "extension/dist/" + runtime]:
                check(not archive.getinfo(entry).is_dir(), f"{vsix_path.name} is missing {entry}")

        files.extend([tgz_path, vsix_path])

    checksums = "".join(f"{sha256(path)}  {path.relative_to(output).as_posix()}\n" for path in sorted(files))
    (output / "RELEASE-SHA256SUMS").write_text(checksums, encoding="utf-8", newline="\n")
    print(checksums, end="")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: verify_release_archives.py ARTIFACT_DIRECTORY")
    try:
        verify(Path(sys.argv[1]))
    except (ValueError, KeyError, OSError, tarfile.TarError, zipfile.BadZipFile) as exc:
        sys.exit(f"Release verification failed: {exc}")
