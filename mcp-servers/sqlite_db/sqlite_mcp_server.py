# -*- coding: utf-8 -*-
"""
sqlite-db-mcp : 로컬 SQLite DB를 MCP 도구로 노출하는 서버(통합 데이터 저장소).

- 여러 문서(hwp/xlsx/docx)에서 추출한 정형 데이터를 한 곳에 축적·집계·질의한다.
- SQLite는 표준입출력 파이프와 무관하므로 **stdio 전송**으로 충분하다.
- 읽기 도구(db_list_tables/db_schema/db_query)와 쓰기 도구(db_execute/db_create_table/
  db_insert)를 분리해, 앱의 "계획 단계"에서 읽기만 허용하기 쉽게 한다.

DB 경로: 환경변수 DOC_MCP_DB_PATH (없으면 ./data.db). WAL 모드(앱이 동시 읽기).
요구사항: pip install "mcp[cli]"  (sqlite3 는 표준 라이브러리)
"""
import os
import re
import sqlite3
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

DB_PATH = os.environ.get("DOC_MCP_DB_PATH", os.path.join(os.getcwd(), "data.db"))

mcp = FastMCP("sqlite-db")

_conn: Optional[sqlite3.Connection] = None


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA foreign_keys=ON")
    return _conn


def _rows(cur) -> list:
    return [dict(r) for r in cur.fetchall()]


# ── 읽기 도구 ──────────────────────────────────────────────────────────
@mcp.tool()
async def db_list_tables() -> Any:
    """DB의 모든 테이블 이름을 반환한다."""
    cur = conn().execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    return {"tables": [r["name"] for r in cur.fetchall()]}


@mcp.tool()
async def db_schema(table: str) -> Any:
    """테이블의 컬럼 스키마를 반환한다."""
    cur = conn().execute(f'PRAGMA table_info("{table}")')
    cols = [{"name": r["name"], "type": r["type"], "notnull": r["notnull"], "pk": r["pk"]}
            for r in cur.fetchall()]
    if not cols:
        return {"error": f"table not found: {table}"}
    return {"table": table, "columns": cols}


@mcp.tool()
async def db_query(sql: str) -> Any:
    """SELECT 쿼리만 실행해 결과 행을 반환한다(읽기 전용)."""
    if not re.match(r"^\s*(select|with|pragma)\b", sql, re.IGNORECASE):
        return {"error": "db_query 는 SELECT/WITH/PRAGMA 만 허용합니다. 변경은 db_execute 를 쓰세요."}
    try:
        cur = conn().execute(sql)
        rows = _rows(cur)
        return {"row_count": len(rows), "rows": rows[:1000]}
    except Exception as e:
        return {"error": str(e)}


# ── 쓰기 도구 (앱의 실행 단계에서만 허용됨) ─────────────────────────────
@mcp.tool()
async def db_create_table(name: str, columns: dict) -> Any:
    """테이블을 생성한다. columns = {컬럼명: "SQLite타입/제약"} 예: {"id":"INTEGER PRIMARY KEY","name":"TEXT"}."""
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
        return {"error": f"invalid table name: {name}"}
    coldefs = ", ".join(f'"{c}" {t}' for c, t in columns.items())
    sql = f'CREATE TABLE IF NOT EXISTS "{name}" ({coldefs})'
    try:
        conn().execute(sql)
        conn().commit()
        return {"created": name, "sql": sql}
    except Exception as e:
        return {"error": str(e), "sql": sql}


@mcp.tool()
async def db_insert(table: str, rows: list) -> Any:
    """행들을 삽입한다. rows = [{컬럼:값, ...}, ...]. 반환: 삽입된 행 수."""
    if not rows:
        return {"inserted": 0}
    cols = list(rows[0].keys())
    placeholders = ", ".join(["?"] * len(cols))
    collist = ", ".join(f'"{c}"' for c in cols)
    sql = f'INSERT INTO "{table}" ({collist}) VALUES ({placeholders})'
    try:
        c = conn()
        c.executemany(sql, [[r.get(col) for col in cols] for r in rows])
        c.commit()
        return {"inserted": len(rows), "table": table}
    except Exception as e:
        return {"error": str(e), "sql": sql}


@mcp.tool()
async def db_execute(sql: str) -> Any:
    """임의의 SQL(INSERT/UPDATE/DELETE/DDL)을 실행한다. 변경 행 수를 반환."""
    try:
        c = conn()
        cur = c.execute(sql)
        c.commit()
        return {"rowcount": cur.rowcount}
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    mcp.run()  # stdio
