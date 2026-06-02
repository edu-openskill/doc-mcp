# Doc MCP Desktop

한글(.hwpx) · 엑셀(.xlsx) · 워드(.docx) 문서를 **자연어로 질의·편집**하는 개인용
윈도우 데스크탑 앱. 채팅에 입력하면 Electron 메인 프로세스가 **claude CLI**를
헤드리스(stream-json) 모드로 구동하고, claude가 **MCP 서버**를 통해 문서를
읽고/수정한다.

```
[채팅 UI] → IPC → [Electron Main] → spawn claude -p (stream-json)
                                        → MCP (hwp-mcp / excel / docx)
                                        → 로컬 문서 파일 CRUD
```

## 사전 요구사항

1. **Node.js 20+** (현재 검증: v24)
2. **claude CLI** 설치 및 로그인(구독)
   ```powershell
   npm i -g @anthropic-ai/claude-code
   claude   # 한 번 실행해 Pro/Max 구독으로 로그인
   ```
3. MCP 서버는 `npx -y` 로 자동 실행되므로 별도 전역 설치 불필요(최초 1회 다운로드).

> ⚠️ **비용**: 2026-06-15부터 `claude -p`(헤드리스) 사용량은 구독 플랜에서
> 대화형과 **분리된 월간 Agent SDK 크레딧**을 소모합니다. 무제한이 아닙니다.

## 실행

```powershell
cd C:\Users\G\workspace\doc-mcp-desktop
npm install
npm start
```

1. 상단 **📁 문서 폴더** 로 작업 폴더 선택 (그 폴더가 claude 작업 디렉터리가 됨).
2. 채팅에 작업 지시. 예:
   - `매출.xlsx 1분기 합계를 B10 셀에 넣어줘`
   - `보고서.hwpx 본문을 3줄로 요약해줘`
   - `계약서_템플릿.hwpx 의 {{이름}} 을 홍길동으로 채워줘`

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

| 파일                          | 역할                                       |
| ----------------------------- | ------------------------------------------ |
| `src/main/main.js`            | Electron 메인 · IPC · 윈도우               |
| `src/main/claude-runner.js`   | claude 헤드리스 spawn · stream-json 파싱   |
| `src/main/preload.js`         | 안전한 IPC 브리지 (contextIsolation)       |
| `src/renderer/*`              | 채팅 UI                                    |
| `mcp.json`                    | MCP 서버 구성 (hwp/excel/docx)             |

## MCP 서버 교체

`mcp.json` 에서 excel/docx 서버 패키지를 환경에 맞게 바꿀 수 있다. 연결 확인:

```powershell
claude mcp add hwp-mcp -- npx -y hwp-mcp
claude mcp list   # ✓ Connected 확인
```
