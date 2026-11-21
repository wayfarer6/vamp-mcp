# WSL2 remote MCP worker

The MCP client starts the VAMP worker over the operator's existing SSH connection. The remote Ubuntu 24.04 or newer WSL2 account runs a rootless Podman container with an isolated 1920x1080 Xvfb desktop. The built-in Robot scenario verifies keyboard input, then returns a small result file with its SHA-256 digest.

**Protect SSH before allowing remote connections.** This setup uses your existing SSH server and leaves its network policy under your control. Use a dedicated account, key-based authentication, verified host keys and appropriate firewall rules. Avoid exposing SSH directly to the public Internet. Keep private keys on the client.

## Install on the WSL host

Install OpenSSH and rootless Podman for your Ubuntu WSL2 account. Confirm you can sign in from the client and independently verify the server host key. Clone this repository into WSL, then run as your SSH user:

```bash
bash platforms/wsl2/setup-wsl-worker.sh
```

For NVIDIA GPU inference, install NVIDIA Container Toolkit with CDI for Podman before setup. The installer selects GPU mode when it sees an NVIDIA CDI device. To explicitly require it, run `VAMP_WSL_VISION=gpu bash platforms/wsl2/setup-wsl-worker.sh`. To install the headless runner without loading vision models, set `VAMP_WSL_VISION=off`. GPU mode loads and checks PaddleOCR and OmniParser YOLO on the **remote host GPU** before starting MCP. A missing CUDA device fails startup. The approved built-in task checks the actual guest screenshot on the GPU. See [NVIDIA's WSL and Podman setup guide](https://docs.nvidia.com/nim/wsl2/latest/getting-started.html).

To optionally limit access to the MCP launcher, create `~/.local/share/vamp-wsl-worker/allowed-peers` on WSL with one CIDR per line. The launcher checks the SSH peer from `SSH_CONNECTION`. This setting applies to MCP only. SSH logins, forwarding and firewall rules are controlled by the existing SSH server.

## Connect from an AI client

Create an OpenSSH client alias named `vamp-wsl` with the host address, user and local identity file. Pin the server's independently verified host key in the client's known-hosts file. The MCP server is stdio over SSH, so it needs no separate HTTP listener. In clients that accept an `mcpServers` JSON configuration, use:

```json
{
  "mcpServers": {
    "vamp-wsl": {
      "command": "ssh",
      "args": [
        "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "vamp-wsl", "exec ~/.local/share/vamp-wsl-worker/worker.sh serve"
      ]
    }
  }
}
```

If the administrator sets a forced SSH command to start the worker, omit the last argument. In AI chat, ask for `worker_status` first. Then authorize `worker_run` with `scenario: "headless_gui_smoke"` and `confirmed: true`. Verify the artifact digest before saving the decoded file. Reconnect when SSH returns after sleep or a network failure. Check the previous result before authorizing a retry.

## WSL2에서 설치하고 AI에 연결하기

**SSH 연결은 운영자가 보호해야 합니다.** 전용 계정, 공개키 인증, 호스트 키 검증, 방화벽을 설정하세요. 공개 인터넷에 SSH를 직접 노출하지 않는 구성을 권장합니다. 설치 스크립트는 기존 SSH 서버 설정을 바꾸지 않습니다.

1. WSL2 Ubuntu 24.04 이상에서 OpenSSH와 rootless Podman을 준비합니다. 일반 SSH 계정으로 저장소를 내려받아 `bash platforms/wsl2/setup-wsl-worker.sh`를 실행합니다.
2. NVIDIA GPU를 사용할 때는 NVIDIA Container Toolkit의 Podman CDI를 먼저 구성합니다. `VAMP_WSL_VISION=gpu`를 지정하면 원격 MCP 시작 시 PaddleOCR와 YOLO를 원격 GPU에서 예열하고 확인합니다. Xvfb 화면만 사용하려면 `VAMP_WSL_VISION=off`를 지정합니다.
3. AI 클라이언트에 위 SSH 기반 MCP 설정을 등록합니다. SSH 호스트 키 지문은 신뢰할 수 있는 별도 경로에서 확인합니다.
4. 채팅으로 `worker_status`를 요청한 뒤 실행을 승인합니다. `worker_run`으로 `headless_gui_smoke`를 실행하고 SHA-256이 일치하는 결과 파일을 저장합니다.
5. MCP 워커의 접속 원본을 제한하고 싶으면 WSL의 `~/.local/share/vamp-wsl-worker/allowed-peers`에 허용 CIDR을 한 줄씩 적습니다. SSH 서버의 접근 정책은 별도로 관리합니다.
