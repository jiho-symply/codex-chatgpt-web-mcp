# codex-chatgpt-web-mcp

**한국어** | [English](README.md)

> **Codex는 workspace를 소유하고, proxy는 browser를 소유하며, ChatGPT는 대화만 봅니다.**

Codex가 로그인된 ChatGPT Web 세션을 reasoning/coding/review backend처럼 사용할
수 있도록 하는 로컬 browser-backed MCP 서버입니다.

핵심 차이는 **ChatGPT에 repository용 MCP를 붙이지 않는다는 것**입니다. Codex가
MCP client이고, 이 서버는 격리된 ChatGPT 브라우저 세션만 제어합니다.

## 구조

```text
Codex
  │
  │ MCP (stdio)
  ▼
codex-chatgpt-web-mcp
  │
  │ Playwright
  ▼
ChatGPT Web
```

ChatGPT가 직접 갖는 권한은 없습니다.

- repository 접근 없음
- Shell 없음
- Git 없음
- Codex MCP 없음
- patch apply 없음
- browser profile/cookie 읽기 도구 없음

ChatGPT는 Codex가 메시지에 넣어준 텍스트만 봅니다.

## 왜 이 구조인가

기존의 workspace bridge 방식은 ChatGPT가 repository를 MCP로 직접 읽기 때문에
ChatGPT가 agent orchestration 구조를 인지하고 workspace capability도 갖게 됩니다.

이 프로젝트는 반대로:

```text
Codex가 repository를 읽음
        ↓
필요한 context만 선택
        ↓
ChatGPT Web MCP에 prompt로 전달
        ↓
ChatGPT 응답
        ↓
Codex가 검증/적용/테스트
```

형태로 동작합니다.

## 보안 원칙

- MCP는 **stdio only**이며 별도 TCP listener를 열지 않습니다.
- ChatGPT Web origin은 `https://chatgpt.com`으로 고정합니다.
- MCP에서 임의 URL을 탐색하는 browser tool을 제공하지 않습니다.
- Browser profile은 project 밖 OS state directory에 저장합니다.
- Cookie/token/password/profile을 읽어오는 MCP tool은 존재하지 않습니다.
- 로그인, CAPTCHA, 2FA 우회 기능을 구현하지 않습니다.
- 한 browser profile에서 요청을 직렬화하여 대화 race를 막습니다.
- request id를 browser 전송 전에 저장해 재시도에 따른 중복 prompt를 막습니다.
- 긴 응답은 하나의 긴 MCP call에 묶지 않고 turn 상태로 복구할 수 있습니다.
- 생성 파일/이미지는 명시적 요청 전에는 다운로드하지 않고 private staging에만 저장합니다.
- ChatGPT 응답은 항상 **untrusted text**로 취급합니다.
- 이 MCP는 patch를 적용하거나 shell/git을 실행할 수 없습니다.

자세한 내용은 [SECURITY.md](SECURITY.md)를 참고하세요.

## 제공 MCP 도구

### `chatgpt_status`

현재 browser profile이 로그인되어 있고 ChatGPT composer를 사용할 수 있는지
확인합니다.

### `chatgpt_capabilities`

현재 계정의 ChatGPT Web에서 실제로 보이는 모델/effort 선택지를 읽습니다.
모델 목록을 코드에 고정하지 않습니다.

### `chatgpt_send` / `chatgpt_wait` / `chatgpt_get_reply` / `chatgpt_stop`

긴 reasoning 작업에서는 이 비동기 도구들을 기본으로 사용합니다.

- `chatgpt_send`: prompt를 한 번만 전송하고 `turn_id` 반환
- `request_id`: 동일 요청의 중복 전송을 막는 idempotency key
- `chatgpt_wait`: 기본 30초 단위로 기다리고, 아직 생성 중이면 그대로 복귀
- `chatgpt_get_reply`: 새 메시지 없이 현재 응답 상태 확인
- `chatgpt_stop`: 해당 turn만 중지

### `chatgpt_get_asset`

구조화된 응답 manifest에서 이미 식별된 파일/이미지를 명시적으로 가져옵니다.
결과는 Codex workspace가 아니라 proxy private state의 staging directory에만
저장됩니다.

### `chatgpt_chat`

짧은 작업을 위한 호환 wrapper입니다. 전체 timeout이 나더라도 `turnId`를
돌려주므로 같은 prompt를 다시 보내지 않고 `wait/get_reply`로 복구할 수 있습니다.

자세한 동작은 [docs/reliability.md](docs/reliability.md)를 참고하세요.

Codex는 필요한 코드만 prompt에 포함시키고, 반환된 코드/diff를 로컬에서 검증한
뒤 적용할 수 있습니다.

## 명시적 입력 첨부

Codex가 선택한 자료를 ChatGPT Web에 첨부할 수 있지만, proxy에 임의 filesystem
read 권한을 주지는 않습니다.

추가 도구:

- `chatgpt_stage_text`
- `chatgpt_stage_blob`
- `chatgpt_list_staged_inputs`
- `chatgpt_discard_staged_input`

staging 결과의 `input_asset_id`를 `chatgpt_send` 또는 `chatgpt_chat`의
`input_asset_ids`에 넘기면 그때 실제 ChatGPT Web 첨부가 발생합니다.

MCP는 local path를 입력으로 받지 않습니다. Source code, diff, log, Markdown,
CSV/TSV, JSON/XML/YAML 등은 text staging으로 처리하고, binary는 PDF, DOCX,
PPTX, XLSX/XLS, PNG/JPEG/GIF만 허용합니다.

.env, private key, credential/secret 계열 파일과 archive/executable/unknown
binary는 차단합니다. 자세한 내용은
[docs/input-attachments.md](docs/input-attachments.md)를 참고하세요.

## 구조화된 응답 처리

turn 결과에는 단순 `response` 문자열뿐 아니라 `manifest`가 포함될 수 있습니다.

현재 구조적으로 구분하는 항목:

- 일반 text
- language metadata를 포함한 code block
- writing/artifact block
- table
- citation
- generated/downloadable file
- image
- preview

코드 작업에서는 flattened text를 다시 파싱하기보다 `type: "code"` part를
우선 사용하는 편이 안전합니다.

파일/이미지는 실제 URL을 MCP에 노출하지 않고 opaque `assetId`로 표시합니다.
필요할 때만 `chatgpt_get_asset`으로 private staging에 가져오며 filename, MIME,
size, SHA-256을 함께 반환합니다.

자세한 형식은 [docs/response-manifest.md](docs/response-manifest.md)를 참고하세요.

## Web UI 상태

브라우저 UI는 다음 상태로 정규화합니다.

`ready / generating / paused / auth_required / challenge_required /
rate_limited / remote_error / unknown`

Retry, Regenerate, Continue generating 버튼은 감지만 하며 자동 클릭하지 않습니다.

자세한 내용은 [docs/web-ui-state.md](docs/web-ui-state.md)를 참고하세요.

## 설치

```bash
git clone https://github.com/jiho-symply/codex-chatgpt-web-mcp.git
cd codex-chatgpt-web-mcp

npm install
npx playwright install chromium
npm run build
```

Linux에서 Chromium dependency까지 설치하려면:

```bash
npx playwright install --with-deps chromium
```

## 최초 로그인

```bash
node dist/cli.js login
```

실제 브라우저가 열립니다. 사용자가 직접 로그인/2FA/CAPTCHA를 처리합니다.

이 프로젝트는 password를 CLI 인자로 받지 않으며 로그인 우회 기능도 없습니다.

로그인 후:

```bash
node dist/cli.js doctor
```

로 headless 세션이 정상인지 확인합니다.

GUI가 없는 Linux server는 [docs/headless-linux.md](docs/headless-linux.md)를
참고하세요.

## Codex 연결

```bash
node dist/cli.js codex-config
```

출력된 TOML을 `~/.codex/config.toml`에 추가합니다.

형태는 다음과 같습니다.

```toml
[mcp_servers.chatgpt_web]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/codex-chatgpt-web-mcp/dist/cli.js", "mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 600
```

이후 Codex가 ChatGPT Web을 비동기 subagent처럼 호출할 수 있습니다.

## 권장 coding 흐름

```text
Codex
 ├─ repository 탐색
 ├─ 관련 파일만 선택
 ├─ request_id와 함께 task + context 전송
 ├─ turn_id를 저장하고 bounded wait
 │
 ▼
ChatGPT
 ├─ reasoning
 ├─ code/diff 작성
 └─ review
 │
 ▼
Codex
 ├─ 응답 검토
 ├─ git apply --check 등 검증
 ├─ 실제 수정
 ├─ test
 └─ git
```

ChatGPT는 이 과정에서 Codex나 local workspace의 존재를 알 필요가 없습니다.

## Headless Linux

MCP/doctor는 기본적으로 headless Chromium을 사용합니다.

다만 최초 로그인은 사용자가 화면을 볼 수 있어야 합니다. SSH X11 forwarding,
임시 VNC/noVNC desktop 등으로 한 번 로그인한 뒤에는 같은 trusted host의
persistent browser profile을 headless로 재사용할 수 있습니다.

## 주의사항

- 공식 ChatGPT API가 아니라 web UI automation입니다.
- ChatGPT Web UI 변경으로 selector가 깨질 수 있습니다.
- selector를 확신할 수 없으면 임의로 클릭하지 않고 `UI_CHANGED` 오류를 냅니다.
- 자동화 browser가 서비스 측 challenge를 받으면 우회하지 않습니다.
- Codex가 prompt에 넣는 코드/정보는 실제 ChatGPT Web으로 전송됩니다.
- 모델 응답은 신뢰하지 말고 실행 전에 검증해야 합니다.

## 고지

OpenAI와 공식 제휴/보증 관계가 없는 비공식 커뮤니티 프로젝트입니다.

서비스 약관과 조직 정책 준수 책임은 사용자에게 있습니다.

## 라이선스

[MIT](LICENSE)
