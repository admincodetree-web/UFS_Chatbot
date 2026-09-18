"""
mcp_server.py -- Family Survey Chatbot MCP Server
===================================================
Exposes read-only SQL tools for the UFS_BOT Oracle table.
Transport: stdio (launched as a subprocess by Flask app.py)

Security:
  - Only SELECT queries are allowed.
  - Schema context comes from schema_whitelist.json (pre-filtered).
  - Dangerous SQL keywords are blocked.
"""

import os
import re
import sys
import json
import oracledb
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

_script_dir = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_script_dir, ".env"))

DB_USER = os.getenv("DB_USER", "")
DB_PASS = os.getenv("DB_PASS", "")
DB_HOST = os.getenv("DB_HOST", "")
DB_PORT = os.getenv("DB_PORT", "1521")
DB_SERVICE = os.getenv("DB_SERVICE", "")

# ---------------------------------------------------------------------------
# Load safe schema from schema_whitelist.json
# ---------------------------------------------------------------------------
_schema_context = ""
_whitelist_path = os.path.join(_script_dir, "schema_whitelist.json")
if os.path.exists(_whitelist_path):
    with open(_whitelist_path, "r", encoding="utf-8") as _f:
        _wl = json.load(_f)
    _table = _wl.get("table", "UFS_CITIZEN_DATA")
    _cols = _wl.get("safe_columns", [])
    _col_lines = "\n".join(
        f"  - {c['column']} ({c['type']}, {'nullable' if c['nullable'] else 'not null'})"
        for c in _cols
    )
    _schema_context = f"TABLE: {_table}\nColumns:\n{_col_lines}"
else:
    # Fallback: use manually known columns from UFS_CITIZEN_DATA (safe ones only)
    _schema_context = """TABLE: UFS_CITIZEN_DATA
Columns:
  - NAME (VARCHAR2) -- Citizen name
  - DATE_OF_BIRTH (DATE)
  - GENDER (VARCHAR2) -- 'MALE' or 'FEMALE'
  - HH_ID (VARCHAR2) -- Household ID
  - CASTE_CATEGORY (VARCHAR2) -- e.g. SC, ST, OBC, OC
  - CASTE (VARCHAR2) -- Specific caste name
  - RELIGION (VARCHAR2) -- e.g. Hindu, Muslim, Christian
  - PURSUING_EDUCATION (VARCHAR2) -- Yes / No
  - CURRENT_EDUCATION_RUNNING (VARCHAR2)
  - CURRENT_EDUCATION_SPECIFY (VARCHAR2)
  - CURRENT_BRANCH (VARCHAR2)
  - PLACE_OF_STUDY (VARCHAR2)
  - MANAGEMENT (VARCHAR2) -- Government / Private
  - HIGHEST_EDUCATION (VARCHAR2)
  - IS_DROPOUT (VARCHAR2)
  - UNDERGONE_SKILL_TRAINING (VARCHAR2) -- Yes / No
  - SKILL_TRAINING_TYPE (VARCHAR2)
  - SKILL_YEAR (VARCHAR2)
  - SKILL_MONTH (VARCHAR2)
  - SOURCE_OF_INCOME (VARCHAR2) -- e.g. Farmer, Unemployed, Salaried
  - OCCUPATION_EXPERIENCE (VARCHAR2) -- years of experience
  - SELF_EMPLOYED (VARCHAR2) -- Yes / No
  - AVG_MONTHLY_INCOME (VARCHAR2)
  - IS_MIGRATED_FOR_WORK (VARCHAR2) -- Yes / No
  - UPSKILL_INTERESTED (VARCHAR2)
  - UPSKILL_OCCUPATION (VARCHAR2)
  - UPSKILL_WORK (VARCHAR2)
  - UPSKILL_WORKLOCATION (VARCHAR2)
  - SURVEYED_BY (VARCHAR2) -- Surveyor ID
  - SURVEY_DONE_ON (TIMESTAMP)
  - IS_CITIZEN_CONSISTENTLY_MAPPED (VARCHAR2)
  - SELECT_REASON_INCONSISTENTLY_MAPPED (VARCHAR2)
  - PERIOD_RESIDING_IN_AP (VARCHAR2)
  - MARITAL_STATUS (VARCHAR2)
  - FATHER_HUSBAND_NAME (VARCHAR2)
  - HIGHEST_BRANCH (VARCHAR2)
  - HIGHEST_YEAR (VARCHAR2)
  - ADD_SUBEDUCATION (VARCHAR2)
  - ADD_BRANCH (VARCHAR2)
  - ADD_YEAR (VARCHAR2)
  - DEDICATED_MOBILE_STATUS (VARCHAR2)
  - MOBIE_NUMBER_OTP_VERIFIED (VARCHAR2)
  - FATHER_IN_SAME_HH (VARCHAR2)
  - HUSBAND_NAME (VARCHAR2)
  - DISTRICT_ID (NUMBER)
  - MANDAL_ID (NUMBER)
  - SECRETARIAT_CODE (NUMBER)
  - CLUSTER_ID (NUMBER)"""


# ---------------------------------------------------------------------------
# Oracle database helper
# ---------------------------------------------------------------------------
def _run_query(sql: str) -> list:
    """Execute a read-only Oracle SQL query and return rows as list of dicts."""
    print(f"\n[MCP SQL EXECUTED]\n{sql.strip()}\n", file=sys.stderr, flush=True)
    dsn = f"{DB_HOST}:{DB_PORT}/{DB_SERVICE}"
    conn = oracledb.connect(user=DB_USER, password=DB_PASS, dsn=dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            columns = [col[0] for col in cur.description]
            rows = cur.fetchall()
            clean_rows = []
            for row in rows:
                clean = {}
                for col, val in zip(columns, row):
                    if isinstance(val, (int, float, str, bool, type(None))):
                        clean[col] = val
                    else:
                        clean[col] = str(val)
                clean_rows.append(clean)
            return clean_rows
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------
mcp = FastMCP("FamilySurvey-UFS")


@mcp.tool()
def run_readonly_sql_query(query: str) -> str:
    """
    Execute a custom read-only SQL SELECT query against the UFS_CITIZEN_DATA table
    in the Oracle database. This is the ONLY tool available. Use it for
    ALL data questions — counts, aggregations, breakdowns, filters, etc.

    IMPORTANT: This is an ORACLE database. Use Oracle SQL syntax:
      - Use FETCH FIRST N ROWS ONLY instead of LIMIT N
      - Use ROWNUM <= N for older Oracle compatibility
      - Use TO_DATE() and TO_TIMESTAMP() for date functions
      - Use NVL() instead of COALESCE() where needed
      - String comparison is CASE-SENSITIVE in Oracle by default

    DATABASE SCHEMA (SAFE COLUMNS ONLY):
{schema}

    QUERY WRITING RULES:
    - Only SELECT queries are allowed. Never INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE.
    - Always reference the table as UFS_CITIZEN_DATA.
    - For text comparisons, use UPPER(column) = UPPER('value') to be case-insensitive.
    - For date formatting in output, use TO_CHAR(date_col, 'DD-MM-YYYY').
    - For aggregations, always GROUP BY all non-aggregate SELECT columns.
    - Maximum 100 rows in result (use FETCH FIRST 100 ROWS ONLY).
    - Do NOT include sensitive columns: AADHAAR_NUMBER, MOBILE_NUMBER, FATHER_HUSBAND_AADHAAR, HUSBAND_AADHAAR.

    Args:
        query: A valid Oracle SELECT query. Must be read-only.
    """.format(schema=_schema_context)

    # Safety: only allow SELECT
    stripped = query.strip().upper()
    if not stripped.startswith("SELECT"):
        return json.dumps({"error": "Only SELECT queries are allowed. This is a read-only tool."})

    # Block dangerous keywords
    dangerous = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT", "REVOKE", "MERGE"]
    for kw in dangerous:
        if re.search(rf"\b{kw}\b", stripped):
            return json.dumps({"error": f"Blocked: '{kw}' operations are not allowed."})

    # Remove trailing semicolon (Oracle Python driver forbids it)
    clean_query = query.strip()
    if clean_query.endswith(";"):
        clean_query = clean_query[:-1]

    try:
        print(f"\n--- [MCP SQL EXECUTED] ---\n{clean_query}\n--------------------------", file=sys.stderr, flush=True)
        rows = _run_query(clean_query)
        if len(rows) > 100:
            rows = rows[:100]
            rows.append({"_note": "Results truncated to 100 rows."})
        return json.dumps(rows, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    mcp.run(transport="stdio")
