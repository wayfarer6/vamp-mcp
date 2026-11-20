# Contributing to VAMP

VAMP welcomes bug reports, documentation updates, and code contributions. Read the [user guide](docs/USER_GUIDE.md) to identify the entry point for the behavior you want to change.

## Report an issue

Search [open issues](https://github.com/wayfarer6/vamp-mcp/issues) first. Include the VAMP version, host and guest operating systems, backend, and whether you used the VS Code extension or standalone MCP. Describe the expected and actual behavior, the smallest reproduction, and any relevant redacted output. For GUI issues, include the guest resolution and whether the coordinates refer to the host or guest.

For a security vulnerability, use GitHub's private vulnerability reporting if available or contact the maintainer privately. Keep credentials, SSH keys, private recordings, and screenshots with personal information out of public reports.

## Open a pull request

1. Fork the repository and branch from `main`.
2. Keep the change focused. Link the issue and describe what changed for users.
3. Test the changed entry point on the backend you used. Give the exact commands and say which tests used mocks, packaged extensions, or a real VM.
4. If setup, behavior, or a user-facing command changes, update the relevant documentation. Keep shared instructions in the English and Korean READMEs aligned.
5. Submit the pull request with any remaining validation named explicitly. Include redacted evidence where it helps reviewers verify the behavior.

Use Node.js 22 or later for npm and extension work. Setup commands for packaging are in the [VS Code build guide](docs/VSCODE_MARKETPLACE.md). Examples of targeted checks from the repository root:

```sh
python -m unittest discover -s tests -p test_rpa_start_screen.py -k virtualbox
node --test vscode-extension/test/remote-backend.cjs
node --test vscode-vault-extension/test/encrypted-export.mjs vscode-vault-extension/test/remote-export.mjs
git diff --check
```

Reusable community RPA submissions belong in the separate [VAMP Script Hub](https://github.com/wayfarer6/vamp-script-hub). For AI-assisted contributions, see [AGENTS.md](AGENTS.md).

## 한국어 안내

이슈에는 VAMP 버전, 호스트와 게스트 OS, 백엔드, 진입점(VS Code 또는 MCP), 기대 동작과 실제 결과를 적어 주세요. PR에서는 관련 이슈와 실행한 테스트를 연결하고, 모의 테스트·패키지 테스트·실제 VM 검증을 구분해 주세요. 자격 증명이나 개인정보가 포함된 기록은 공개 저장소에 올리지 마세요.
