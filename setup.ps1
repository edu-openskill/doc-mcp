# Doc MCP Desktop - 초기 설정 스크립트 (Windows / 한컴오피스 필요)
# 실행:  powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"
Write-Host "[1/4] Node 의존성 설치 (electron)..." -ForegroundColor Cyan
npm install

Write-Host "[2/4] Python 의존성 설치 (pyhwpx, pywin32, mcp)..." -ForegroundColor Cyan
python -m pip install --upgrade -r "mcp-servers/hwpx_com/requirements.txt"

Write-Host "[3/4] 한컴 보안 모듈 등록 (FilePathCheckerModule)..." -ForegroundColor Cyan
$dll = python -c "import os,pyhwpx; print(os.path.join(os.path.dirname(pyhwpx.__file__),'FilePathCheckerModule.dll'))"
if (-not (Test-Path $dll)) { throw "보안 모듈 DLL을 찾을 수 없습니다: $dll" }
$key = "HKCU:\SOFTWARE\HNC\HwpAutomation\Modules"
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name "FilePathCheckerModule" -Value $dll -PropertyType String -Force | Out-Null
Write-Host "    등록됨: $dll"

Write-Host "[4/4] claude CLI 확인..." -ForegroundColor Cyan
$claude = (Get-Command claude -ErrorAction SilentlyContinue)
if ($claude) {
  Write-Host "    claude: $($claude.Source)"
} else {
  Write-Host "    [경고] claude CLI 미설치 → 'npm i -g @anthropic-ai/claude-code' 후 'claude' 로 로그인하세요." -ForegroundColor Yellow
}

Write-Host "`n설정 완료. 'npm start' 로 실행하세요." -ForegroundColor Green
