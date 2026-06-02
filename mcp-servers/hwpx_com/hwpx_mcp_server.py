# -*- coding: utf-8 -*-
"""
hwpx-com-mcp : 한컴오피스 HWP COM API(HwpObject)를 MCP 도구로 노출하는 서버.

설계 근거(모두 실측으로 확인):
- 백엔드는 pyhwpx(win32com) → 한컴이 직접 열기/편집/저장하므로 병합 셀·빈 셀·
  서식·PDF까지 완전 처리(파싱 한계 없음).
- 한컴 COM open() 은 표준입출력이 "파이프"로 리다이렉트되면 멈춘다.
  → MCP는 stdio 대신 **HTTP(streamable-http)** 로 통신하고, 부모(Electron)는 이
    프로세스를 파이프 없이(NUL 핸들)로 띄운다.
- COM을 비동기 이벤트루프/STA 스레드에서 호출하면 메시지펌프 부재로 멈춘다.
  → 전용 **MTA 워커 스레드**(CoInitializeEx MULTITHREADED)가 Hwp 객체를 소유하고
    모든 COM 호출을 직렬 처리한다. async 도구는 이 워커에 위임만 한다.
- 셀은 스프레드시트식 주소(예 "B23"). 열=A,B,C… / 행=1부터.

요구사항: 한컴오피스(HWP) 설치, pip install pyhwpx pywin32 "mcp[cli]"
보안모듈: HKCU\\SOFTWARE\\HNC\\HwpAutomation\\Modules\\FilePathCheckerModule 에
          pyhwpx의 FilePathCheckerModule.dll 경로 등록(설치 스크립트가 처리).
"""
import os
import queue
import threading
import traceback
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

HOST = os.environ.get("HWPX_MCP_HOST", "127.0.0.1")
PORT = int(os.environ.get("HWPX_MCP_PORT", "8765"))


# ── MTA COM 워커 스레드 ────────────────────────────────────────────────
class HwpWorker:
    def __init__(self):
        self._q: "queue.Queue" = queue.Queue()
        self.hwp = None
        self.path: Optional[str] = None
        self._t = threading.Thread(target=self._loop, daemon=True)
        self._t.start()

    def _loop(self):
        import pythoncom
        pythoncom.CoInitializeEx(pythoncom.COINIT_MULTITHREADED)
        try:
            while True:
                fn, args, kwargs, fut = self._q.get()
                if fn is None:
                    break
                try:
                    fut["result"] = fn(*args, **kwargs)
                except Exception as e:
                    fut["error"] = f"{e}\n{traceback.format_exc()}"
                finally:
                    fut["done"].set()
        finally:
            pythoncom.CoUninitialize()

    def call(self, fn, *args, **kwargs):
        fut = {"done": threading.Event(), "result": None, "error": None}
        self._q.put((fn, args, kwargs, fut))
        fut["done"].wait()
        if fut["error"]:
            raise RuntimeError(fut["error"])
        return fut["result"]

    # 아래 _ensure/_goto 는 워커 스레드에서만 호출된다 -------------------
    def ensure(self):
        if self.hwp is None:
            from pyhwpx import Hwp
            self.hwp = Hwp(new=True, visible=False)
            try:
                self.hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
            except Exception:
                pass
            try:
                self.hwp.set_message_box_mode(0x00020000)
            except Exception:
                pass
        return self.hwp

    def goto_cell(self, addr: str, table_index: int = 0) -> bool:
        h = self.ensure()
        h.set_pos(0, 0, 0)
        if not h.get_into_nth_table(table_index):
            return False
        for _ in range(2000):
            if h.get_cell_addr() == addr:
                return True
            if not h.TableRightCell():
                return False
        return False


W = HwpWorker()
mcp = FastMCP("hwpx-com", host=HOST, port=PORT)


# ── 워커 위에서 도는 실제 동작들 ───────────────────────────────────────
def _open(path):
    h = W.ensure(); h.open(path); W.path = path
    return {"opened": path}

def _status():
    return {"open": W.hwp is not None, "path": W.path}

def _get_text():
    return W.ensure().GetTextFile("TEXT", "")

def _read_table(table_index):
    h = W.ensure(); h.set_pos(0, 0, 0)
    if not h.get_into_nth_table(table_index):
        return {"error": f"table {table_index} not found"}
    grid, last = {}, None
    for _ in range(4000):
        addr = h.get_cell_addr()
        if addr == last:
            break
        h.TableCellBlock()
        txt = (h.get_selected_text() or "").replace("\r", " ").replace("\n", " ").strip()
        h.Cancel()
        grid[addr] = txt
        last = addr
        if not h.TableRightCell():
            break
    return {"cells": grid}

def _get_cell(addr, table_index):
    h = W.ensure()
    if not W.goto_cell(addr, table_index):
        return {"error": f"cell {addr} not found"}
    h.TableCellBlock(); txt = (h.get_selected_text() or "").strip(); h.Cancel()
    return {"addr": addr, "text": txt}

def _set_cell(addr, text, table_index):
    h = W.ensure()
    if not W.goto_cell(addr, table_index):
        return {"error": f"cell {addr} not found"}
    h.TableCellBlock(); h.Delete(); h.Cancel(); h.insert_text(text)
    return {"addr": addr, "set": text}

def _find_replace(find, replace, replace_all):
    h = W.ensure()
    cnt = h.find_replace_all(find, replace) if replace_all else h.find_replace(find, replace)
    return {"replaced": cnt}

def _insert_text(text, at_end):
    h = W.ensure()
    if at_end:
        h.MoveDocEnd()
    h.insert_text(text)
    return {"inserted": text}

def _append_row(table_index):
    h = W.ensure(); h.set_pos(0, 0, 0); h.get_into_nth_table(table_index); h.TableAppendRow()
    return {"appended_row": True}

def _set_cell_format(addr, table_index, bold, italic, underline, align, fg_color):
    h = W.ensure()
    if not W.goto_cell(addr, table_index):
        return {"error": f"cell {addr} not found"}
    h.TableCellBlock(); applied = []
    try:
        if bold: h.CharShapeBold(); applied.append("bold")
        if italic: h.CharShapeItalic(); applied.append("italic")
        if underline: h.CharShapeUnderline(); applied.append("underline")
        if align == "center": h.ParagraphShapeAlignCenter(); applied.append("center")
        elif align == "right": h.ParagraphShapeAlignRight(); applied.append("right")
        elif align == "left": h.ParagraphShapeAlignLeft(); applied.append("left")
        if fg_color:
            try: h.set_font(TextColor=fg_color); applied.append(f"color={fg_color}")
            except Exception: pass
    finally:
        h.Cancel()
    return {"addr": addr, "applied": applied}

def _save():
    W.ensure().save(); return {"saved": W.path}

def _save_as(path, fmt):
    h = W.ensure()
    h.save_as(path, fmt) if fmt else h.save_as(path)
    return {"saved_as": path}

def _export_pdf(path):
    W.ensure().save_as(path, "PDF"); return {"pdf": path}

def _close():
    if W.hwp is not None:
        try: W.hwp.clear()
        except Exception: pass
    W.path = None
    return {"closed": True}


# ── MCP 도구 (async → MTA 워커로 위임) ─────────────────────────────────
@mcp.tool()
async def hwp_open(path: str) -> Any:
    """HWP/HWPX 파일을 연다. 이후 도구는 이 문서를 대상으로 동작한다."""
    return W.call(_open, path)

@mcp.tool()
async def hwp_status() -> Any:
    """현재 열린 문서 경로를 반환한다."""
    return W.call(_status)

@mcp.tool()
async def hwp_get_text() -> Any:
    """문서 본문 전체 텍스트를 반환한다."""
    return W.call(_get_text)

@mcp.tool()
async def hwp_read_table(table_index: int = 0) -> Any:
    """표를 셀주소→텍스트 딕셔너리로 읽는다(예 {"A1":"번호","B23":"홍길동"})."""
    return W.call(_read_table, table_index)

@mcp.tool()
async def hwp_get_cell(addr: str, table_index: int = 0) -> Any:
    """셀 주소(예 "B23")의 텍스트를 읽는다."""
    return W.call(_get_cell, addr, table_index)

@mcp.tool()
async def hwp_set_cell(addr: str, text: str, table_index: int = 0) -> Any:
    """셀 주소(예 "B23")에 텍스트를 쓴다(기존 내용 대체). 빈/병합 셀도 처리."""
    return W.call(_set_cell, addr, text, table_index)

@mcp.tool()
async def hwp_find_replace(find: str, replace: str, replace_all: bool = True) -> Any:
    """문서 전체에서 문자열을 찾아 바꾼다."""
    return W.call(_find_replace, find, replace, replace_all)

@mcp.tool()
async def hwp_insert_text(text: str, at_end: bool = True) -> Any:
    """캐럿(또는 문서 끝)에 텍스트를 삽입한다."""
    return W.call(_insert_text, text, at_end)

@mcp.tool()
async def hwp_append_row(table_index: int = 0) -> Any:
    """표 마지막에 행을 추가한다."""
    return W.call(_append_row, table_index)

@mcp.tool()
async def hwp_set_cell_format(
    addr: str, table_index: int = 0, bold: bool = False, italic: bool = False,
    underline: bool = False, align: str = "", fg_color: str = "",
) -> Any:
    """셀 서식 적용(굵게/기울임/밑줄/정렬 left|center|right/글자색)."""
    return W.call(_set_cell_format, addr, table_index, bold, italic, underline, align, fg_color)

@mcp.tool()
async def hwp_save() -> Any:
    """현재 경로에 그대로 저장(in-place)."""
    return W.call(_save)

@mcp.tool()
async def hwp_save_as(path: str, fmt: str = "") -> Any:
    """다른 경로/형식으로 저장(확장자 또는 fmt로 형식 결정)."""
    return W.call(_save_as, path, fmt)

@mcp.tool()
async def hwp_export_pdf(path: str) -> Any:
    """현재 문서를 PDF로 내보낸다."""
    return W.call(_export_pdf, path)

@mcp.tool()
async def hwp_close() -> Any:
    """현재 문서를 닫는다(한컴 프로세스는 유지)."""
    return W.call(_close)


if __name__ == "__main__":
    mcp.run(transport="streamable-http")  # http://HOST:PORT/mcp
