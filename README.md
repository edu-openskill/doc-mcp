# Doc MCP Desktop

한글(.hwp/.hwpx) · 엑셀(.xlsx) · 워드(.docx) 문서를 **자연어로 질의·편집**하는
개인용 윈도우 데스크탑 앱. 채팅에 입력하면 Electron 메인 프로세스가 **claude CLI**를
헤드리스(stream-json) 모드로 구동하고, claude가 **MCP 서버**를 통해 문서를 읽고/수정한다.

한글은 **한컴오피스 COM API**를 MCP 도구로 감싼 자체 서버(`hwpx-com`)를 쓴다.
한컴이 직접 열고/편집/저장하므로 **병합 셀·빈 셀·서식·PDF까지 완전 처리**된다
(파싱 기반 hwp-mcp가 실패하던 빈/병합 셀 쓰기 문제 해결).

```
[채팅 UI] → IPC → [Electron Main] ┬→ spawn claude -p (stream-json)
                                   │      └→ MCP: hwp(HTTP) / excel·docx(stdio)
                                   └→ spawn hwpx-com 서버(python, HTTP)
                                          └→ 한컴 COM(HwpObject) → 문서 CRUD
```

### 왜 한글 서버만 HTTP 전송인가 (중요한 설계 결정, 모두 실측)
- 한컴 COM `open()` 은 표준입출력이 **파이프로 리다이렉트되면 멈춘다**.
  MCP **stdio** 전송은 파이프가 필수라 충돌 → 그래서 한글 서버는 **HTTP**로 통신하고,
  앱은 이 프로세스를 **파이프 없이(stdio: 'ignore')** 띄운다.
- 한컴 COM을 STA 스레드(메시지펌프 없음)에서 호출하면 멈춘다 → 전용 **MTA 워커
  스레드**가 모든 COM 호출을 직렬 처리한다.

## 사전 요구사항

1. **Node.js 20+** (검증: v24) / **Python 3.10+** (검증: 3.14)
2. **한컴오피스(HWP)** 설치 — 한글 편집의 COM 백엔드 (검증: Office 2020)
3. **claude CLI** 설치 및 로그인(구독)
   ```powershell
   npm i -g @anthropic-ai/claude-code
   claude   # 한 번 실행해 Pro/Max 구독으로 로그인
   ```

> ⚠️ **비용**: 2026-06-15부터 `claude -p`(헤드리스) 사용량은 구독 플랜에서
> 대화형과 **분리된 월간 Agent SDK 크레딧**을 소모합니다. 무제한이 아닙니다.

## 설치 & 실행

```powershell
cd C:\Users\G\workspace\doc-mcp-desktop
powershell -ExecutionPolicy Bypass -File setup.ps1   # 의존성 + 한컴 보안모듈 등록
npm start
```

`setup.ps1` 이 하는 일: npm 설치 → python 의존성(pyhwpx/pywin32/mcp) 설치 →
한컴 보안모듈(FilePathCheckerModule) 레지스트리 등록 → claude CLI 확인.

1. 상단 **📁 문서 폴더** 로 작업 폴더 선택 (그 폴더가 claude 작업 디렉터리가 됨).
2. 채팅에 작업 지시. 예:
   - `매출.xlsx 1분기 합계를 B10 셀에 넣어줘`
   - `보고서.hwpx 본문을 3줄로 요약해줘`
   - `계약서_템플릿.hwpx 의 {{이름}} 을 홍길동으로 채워줘`

### 생성 중지

생성(답변)이 진행되는 동안 **전송 버튼이 "■ 중지"로 바뀝니다.** 이를 누르거나
**Esc** 키를 누르면 현재 답변만 중단되고 세션은 그대로 유지되어 바로 다음
메시지를 보낼 수 있습니다. (내부적으로 stream-json `interrupt` 제어 메시지를 사용 —
프로세스를 죽이지 않음.) 대화 전체를 비우려면 **↺ 새 대화**.

## 패키징 (Windows 인스톨러)

```powershell
npm run dist   # electron-builder → NSIS 설치 파일
```

## 형식 지원

| 형식         | 읽기 | 쓰기 |
| ------------ | :--: | :--: |
| .xlsx        |  ✅  |  ✅  |
| .docx        |  ✅  |  ✅  |
| .hwpx        |  ✅  |  ✅  |
| .hwp (구형)  |  ✅  |  ❌  |

구형 바이너리 `.hwp`는 읽기만 가능. 편집하려면 한컴오피스에서 `.hwpx`로
"다른 이름으로 저장" 후 사용하세요.

## 구조

| 파일                                          | 역할                                         |
| --------------------------------------------- | -------------------------------------------- |
| `src/main/main.js`                            | Electron 메인 · IPC · 서버 수명주기          |
| `src/main/claude-runner.js`                   | claude 헤드리스 spawn · stream-json · 인터럽트 |
| `src/main/hwpx-server.js`                     | 한컴 COM HWPX MCP 서버(HTTP) 기동/종료       |
| `src/main/preload.js`                         | 안전한 IPC 브리지 (contextIsolation)         |
| `src/renderer/*`                              | 채팅 UI (전송/중지 토글, 스트리밍)           |
| `mcp-servers/hwpx_com/hwpx_mcp_server.py`     | 한컴 COM → MCP 도구(HTTP) 서버               |
| `system-prompt.md`                            | claude 규칙(도구 사용·쓰기 후 재조회 검증)   |
| `setup.ps1`                                   | 의존성 설치 + 보안모듈 등록                  |

MCP 설정은 앱 실행 시 `userData/mcp.runtime.json` 으로 **자동 생성**된다
(hwp=HTTP, excel/docx=stdio). `mcp.json` 은 참고용 템플릿.

## 한글(hwpx-com) 도구

`hwp_open`, `hwp_get_text`, `hwp_read_table`(셀주소→텍스트), `hwp_get_cell`,
`hwp_set_cell`, `hwp_find_replace`, `hwp_insert_text`, `hwp_append_row`,
`hwp_set_cell_format`(굵게/정렬/색…), `hwp_save`, `hwp_save_as`, `hwp_export_pdf`,
`hwp_close`. 셀은 스프레드시트식 주소(예 `B23`)로 지정한다.

## 형식 지원 (업데이트)

| 형식         | 읽기 | 쓰기 | 비고 |
| ------------ | :--: | :--: | ---- |
| .hwpx        |  ✅  |  ✅  | 한컴 COM (병합/빈 셀·서식·PDF 포함) |
| .hwp (구형)  |  ✅  |  ✅  | 한컴 COM 으로 직접 편집 가능 |
| .xlsx        |  ✅  |  ✅  | excel MCP |
| .docx        |  ✅  |  ✅  | docx MCP |
