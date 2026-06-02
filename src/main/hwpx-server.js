'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

/**
 * 한컴 COM HWPX MCP 서버(파이썬, HTTP 전송)를 관리한다.
 *
 * 중요: 한컴 COM open() 은 표준입출력이 파이프면 멈춘다. 따라서 이 프로세스는
 * stdio: 'ignore'(NUL 핸들)로 띄우고, 통신은 HTTP(127.0.0.1:PORT/mcp)로 한다.
 */
const SERVER_SCRIPT = path.join(
  __dirname, '..', '..', 'mcp-servers', 'hwpx_com', 'hwpx_mcp_server.py'
);

function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    sock.setTimeout(800);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkPort(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

class HwpxServer {
  constructor(port = 8765, pythonCmd = 'python') {
    this.port = port;
    this.pythonCmd = pythonCmd;
    this.proc = null;
  }

  get url() {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(onLog) {
    if (await checkPort(this.port)) {
      // 이미 떠 있으면 재사용
      return true;
    }
    this.proc = spawn(this.pythonCmd, ['-u', SERVER_SCRIPT], {
      // 파이프 금지(COM 멈춤 방지). 출력은 버린다.
      stdio: 'ignore',
      env: { ...process.env, HWPX_MCP_PORT: String(this.port), PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    this.proc.on('exit', (code) => {
      onLog && onLog(`hwpx-server exited (${code})`);
      this.proc = null;
    });
    const ok = await waitForPort(this.port);
    if (!ok) {
      onLog && onLog('hwpx-server 포트 응답 없음 (한컴/파이썬 의존성 확인 필요)');
    }
    return ok;
  }

  stop() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

module.exports = { HwpxServer };
