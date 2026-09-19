# codex-chatgpt-web-mcp

**한국어** | [English](README.md)

로그인된 **ChatGPT Web**을 Codex의 외부 reasoning/coding/review backend처럼
사용할 수 있게 하는 로컬 MCP 서버입니다.

repository, shell, Git, test, patch 적용은 계속 Codex가 소유하고,
ChatGPT에는 Codex가 명시적으로 선택한 prompt와 file만 전달됩니다.

## Codex에게 설치시키기

아래 프롬프트를 **로컬 Codex 세션**에 그대로 붙여넣으세요.

```text
이 머신에 codex-chatgpt-web-mcp를 설치해줘.

Repository:
https://github.com/jiho-symply/codex-chatgpt-web-mcp

개발/source-build 방식이 아니라 일반 사용자 설치 절차를 사용해.
현재 작업 중인 project 파일은 수정하지 마.

1. Node.js >= 20과 Edge/Chrome/Chromium 중 지원 브라우저가 있는지 확인해.
2. Codex가 MCP를 시작하기 전에 CGW를 한 번 설치해:
   npm install -g codex-chatgpt-web-mcp@latest
3. 다음 명령을 실행해:
   cgw login
   ChatGPT 로그인, CAPTCHA, 2FA처럼 사람의 조작이 필요하면 브라우저를 열어둔 채 나에게 완료해달라고 요청하고 기다려.
4. 이미 설치된 launcher를 MCP로 등록해:
   codex mcp add chatgpt-web -- cgw mcp
5. 다음 명령으로 등록을 확인해:
   codex mcp list
6. 저장되는 MCP command에 `npx ... mcp`를 넣지 마. Codex의 MCP startup timeout에는 npm/network cold start 시간도 포함돼.
7. 문서화된 package 설치 방식이 실제로 실패하기 전에는 repository를 clone/build하지 마.
8. 현재 Codex 세션이 새 MCP를 바로 인식하지 못하면 Codex를 재시작해야 한다고 알려줘.

문제가 생기면 추측해서 우회하지 말고 실패한 명령과 실제 오류를 보여줘.
```

Codex에 local shell 실행 권한이 있으면 설치와 등록은 스스로 처리할 수 있습니다.
사용자가 직접 해야 하는 부분은 ChatGPT 로그인/2FA/CAPTCHA와, 필요한 경우 설치
후 Codex 재시작 정도입니다.

## 직접 설치

요구사항: **Node.js 20+**, 로컬 브라우저.

- Windows: Microsoft Edge 또는 Google Chrome
- Linux: Google Chrome 또는 Chromium

```bash
# MCP startup 경로 밖에서 한 번 설치
npm install -g codex-chatgpt-web-mcp@latest

# 최초 1회 ChatGPT 로그인
cgw login

# 이미 설치된 launcher를 Codex에 등록
codex mcp add chatgpt-web -- cgw mcp
```

persistent MCP command로
`npx -y codex-chatgpt-web-mcp@latest mcp`를 등록하지 않는 것을 권장합니다.
cold npm/network resolution이 CGW initialize 전에 Codex의 MCP startup budget을
소모할 수 있습니다.

확인:

```bash
codex mcp list
```

같은 host의 Codex CLI, ChatGPT/Codex desktop app, Codex IDE integration은
동일한 MCP 설정을 공유합니다. UI-only 설정과 플랫폼별 세부 내용은
[docs/installation.md](docs/installation.md)를 참고하세요.

## Use cases

- **코드 검토 / second opinion** — diff, 구현 코드, test 결과를 ChatGPT에 보내
  검토시키되 전체 orchestration은 Codex가 담당
- **긴 reasoning** — 어려운 분석을 위임하고 timeout 후에도 같은 turn을 복구
- **파일/문서 분석** — source, log, PDF, Office 문서, CSV/JSON/YAML,
  screenshot/image를 명시적으로 첨부
- **구조화된 출력** — code block, table, citation, generated file/image 등을
  response manifest로 전달
- **workspace별 context 격리** — 각 workspace를 Project-only memory가 적용된
  별도 `CGW-...` ChatGPT Project에 연결

## 동작 방식

```text
Codex ── MCP / stdio ──▶ CGW ── browser ──▶ ChatGPT Web
  │                                          │
  ├─ repo / shell / Git / test               └─ 선택된 prompt/file만
  └─ 결과 검증 / 적용
```

핵심 동작:

- repository 밖 private state에 persistent browser profile 저장
- Windows / Linux system browser 자동 탐색
- 신규 workspace Project에 `CGW-` prefix
- explicit input staging — arbitrary workspace file reader 없음
- idempotent request ID 기반 `send → wait → get_reply`
- text/code/file/image/table/citation 등의 structured response extraction
- 생성 asset은 private staging을 거친 뒤 Codex가 사용 여부 결정
- ChatGPT에 shell, Git, patch apply, arbitrary URL navigation, cookie export,
  CAPTCHA bypass, stealth capability를 제공하지 않음

## 문서

상세 설명은 README에서 분리했습니다.

- [문서 인덱스](docs/README.md)
- [설치 / Windows / Linux / Codex UI](docs/installation.md)
- [Codex 연동](docs/codex.md)
- [Architecture](docs/architecture.md)
- [Workspace → Project isolation](docs/workspace-project-isolation.md)
- [Input attachments](docs/input-attachments.md)
- [Structured responses](docs/response-manifest.md)
- [Reliability / async turns](docs/reliability.md)
- [Security](SECURITY.md)

## 기타

- 공식 ChatGPT API가 아니라 ChatGPT Web browser automation입니다.
- 최초 ChatGPT 로그인은 사용자가 직접 수행합니다.
- ChatGPT Web UI가 바뀌면 selector가 깨질 수 있으며, 애매한 UI에서는 fail closed합니다.
- CGW를 통해 명시적으로 업로드한 내용은 실제 ChatGPT 계정으로 전송됩니다.
- ChatGPT 결과는 untrusted output으로 취급하고 Codex가 사용 전에 검증해야 합니다.

## License

[MIT](LICENSE)
