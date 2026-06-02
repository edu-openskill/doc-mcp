# -*- coding: utf-8 -*-
"""
대시보드용 읽기 전용 헬퍼. Electron 메인이 일회성으로 호출해 표 데이터를 JSON 으로 받는다.
(네이티브 node 모듈 불필요 + WAL 정확히 읽음. 이미 파이썬이 의존성이라 추가 비용 없음.)

사용:
  python db_read.py tables
  python db_read.py rows <table> <limit> <offset>
  python db_read.py query "<SELECT ...>"
DB 경로: 환경변수 DOC_MCP_DB_PATH
"""
import os
import re
import sys
import json
import sqlite3

DB = os.environ.get("DOC_MCP_DB_PATH", os.path.join(os.getcwd(), "data.db"))


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))


def main():
    if not os.path.exists(DB):
        return out({"tables": [], "rows": [], "columns": [], "note": "DB 없음(아직 데이터 없음)"})
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "tables"

    if cmd == "tables":
        cur = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        return out({"tables": [r["name"] for r in cur.fetchall()]})

    if cmd == "rows":
        table = sys.argv[2]
        limit = int(sys.argv[3]) if len(sys.argv) > 3 else 100
        offset = int(sys.argv[4]) if len(sys.argv) > 4 else 0
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", table):
            return out({"error": "invalid table"})
        total = con.execute(f'SELECT COUNT(*) c FROM "{table}"').fetchone()["c"]
        cur = con.execute(f'SELECT * FROM "{table}" LIMIT ? OFFSET ?', (limit, offset))
        rows = [dict(r) for r in cur.fetchall()]
        cols = [d[0] for d in cur.description] if cur.description else []
        return out({"table": table, "total": total, "columns": cols, "rows": rows})

    if cmd == "query":
        sql = sys.argv[2]
        if not re.match(r"^\s*(select|with|pragma)\b", sql, re.IGNORECASE):
            return out({"error": "SELECT 쿼리만 허용됩니다."})
        cur = con.execute(sql)
        rows = [dict(r) for r in cur.fetchall()]
        cols = [d[0] for d in cur.description] if cur.description else []
        return out({"columns": cols, "rows": rows[:1000], "row_count": len(rows)})

    return out({"error": f"unknown command: {cmd}"})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        out({"error": str(e)})
