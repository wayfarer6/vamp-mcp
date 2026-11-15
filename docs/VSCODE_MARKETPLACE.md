# VAMP VS Code Marketplace 배포

확장 코드는 `vscode-extension/`이며 정식 VSIX manifest, README, CHANGELOG, MIT 및 외부 라이선스 고지를 포함합니다. MCP 서버는 stdio이며 VS Code의 `McpServerDefinitionProvider`에 등록됩니다. 독립 native MCP 설정을 원하는 사용자는 저장소의 서버 명령을 직접 등록해도 됩니다.

## 빌드·로컬 설치

```bash
cd third_party/mcp-virtualbox
npm ci --ignore-scripts
npm run build
cd ../../vscode-extension
npm ci --ignore-scripts
npm run package
code --install-extension ../artifacts/vamp-mcp-0.1.0.vsix
```

마지막 설치 명령은 사용자 자신의 VS Code에서 실행하세요. 확장은 자동으로 VM/게스트 패키지를 설치하지 않습니다. 최초 **VAMP: Set Up Python Environment** 명령으로 private venv를 만든 다음, **VAMP: Create VM From ISO**로 파일 선택 창에서 ISO를 고르면 결정론적 설치기가 수행됩니다. 기본 공개 계정 `vboxuser / password123!`를 선택 창과 결과에서 안내합니다.

기본 제어는 별도 Node 설치 없이 desktop VS Code 런타임을 사용합니다. Python/VirtualBox/시스템 드라이버는 별도로 있어야 합니다. 마우스용 VirtualBox SDK, vision용 GPU 런타임도 별도입니다. Windows/Linux/macOS 대상 단일 VSIX이지만 플랫폼별 실제 동작을 검증했다는 뜻은 아닙니다. ARM ISO는 초기 자동 설치 프로필에서 지원하지 않습니다.

## 게시자 등록과 업로드

`package.json`의 publisher `wayfarer6`는 사용자가 지정한 게시자 ID입니다. 실제 Marketplace 등록/권한은 아직 확인하지 못했습니다. Marketplace에서 해당 ID를 소유/등록한 뒤 실제 publisher에 맞게 수정하고 재패키징해야 합니다. GitHub 로그인이나 VS Code 로그인만으로 Marketplace 게시 권한이 생기지 않습니다.

1. [Marketplace 게시자 관리](https://marketplace.visualstudio.com/manage)에서 로그인하고 Publisher를 생성하거나 기존 Publisher의 권한을 확인합니다.
2. publisher ID와 확장 정보/라이선스/preview 상태를 검토합니다. 현재 버전은 실험적 preview이므로 manifest의 preview 표기를 유지합니다.
3. 관리 페이지의 **New extension → Visual Studio Code**에서 생성한 VSIX를 업로드할 수 있습니다. 이 방법은 토큰을 채팅에 전달할 필요가 없습니다.
4. CLI를 선호하면 공식 문서의 `vsce login <publisher>` / `vsce publish` 또는 지원되는 CI 인증을 설정합니다. 토큰은 채팅·Git·명령 인자에 남기지 않습니다.

실제 Marketplace 게시/공개 URL은 아직 생성하지 않았습니다. VSIX 패키징, MCP 프로토콜 테스트와 실제 VS Code UI/게스트 OS 설치 검증을 구분하세요.

공식 문서: [MCP extension API](https://code.visualstudio.com/api/extension-guides/ai/mcp), [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
