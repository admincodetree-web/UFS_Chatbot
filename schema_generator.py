"""
schema_generator.py -- One-time Schema Discovery and Security Filter
====================================================================
Run this script ONCE manually before starting the chatbot:
    python schema_generator.py

What it does:
  1. Connects to the Oracle database using credentials from .env
  2. Fetches all columns of the target table (UFS_BOT)
  3. Runs a blacklist filter to strip sensitive columns automatically
  4. Saves the safe, filtered schema to schema_whitelist.json
"""

import os
import json
import oracledb
from dotenv import load_dotenv

load_dotenv()

TARGET_TABLE = "UFS_CITIZEN_DATA"

SENSITIVE_KEYWORDS = [
    "aadhar", "aadhaar", "pan", "ssn", "passport",
    "voter_id", "biometric", "fingerprint",
    "phone", "mobile", "email", "contact", "whatsapp",
    "salary", "income", "account", "bank", "ifsc", "card", "cvv",
    "credit", "debit", "balance", "loan", "wage",
    "address", "door_no", "house_no",
    "password", "passwd", "pwd", "hash", "salt", "token", "secret", "otp", "pin",
    "medical", "health", "blood",
    "father_husband_aadhaar", "husband_aadhaar",
]

def get_connection():
    user = os.getenv("DB_USER")
    password = os.getenv("DB_PASS")
    host = os.getenv("DB_HOST")
    port = os.getenv("DB_PORT", "1521")
    service = os.getenv("DB_SERVICE")
    if not all([user, password, host, service]):
        raise ValueError("Missing Oracle DB credentials in .env")
    dsn = f"{host}:{port}/{service}"
    return oracledb.connect(user=user, password=password, dsn=dsn)

def is_sensitive(column_name):
    col_lower = column_name.lower()
    return any(kw in col_lower for kw in SENSITIVE_KEYWORDS)

def generate_schema():
    print("Connecting to Oracle database...")
    conn = get_connection()
    cursor = conn.cursor()
    print(f"Fetching columns for table: {TARGET_TABLE}")
    cursor.execute("""
        SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE
        FROM ALL_TAB_COLUMNS
        WHERE UPPER(TABLE_NAME) = UPPER(:tname)
        ORDER BY COLUMN_ID
    """, tname=TARGET_TABLE)
    rows = cursor.fetchall()
    if not rows:
        print(f"WARNING: No columns found for '{TARGET_TABLE}'. Trying wildcard match...")
        cursor.execute("""
            SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE
            FROM ALL_TAB_COLUMNS
            WHERE UPPER(TABLE_NAME) LIKE :tname
            ORDER BY COLUMN_ID
        """, tname=f"%{TARGET_TABLE.upper()}%")
        rows = cursor.fetchall()
        if not rows:
            print("No columns found. Check the table name.")
            cursor.close(); conn.close(); return
    all_columns, filtered_out, safe_columns = [], [], []
    for col_name, data_type, data_length, nullable in rows:
        all_columns.append(col_name)
        if is_sensitive(col_name):
            filtered_out.append(col_name)
        else:
            safe_columns.append({"column": col_name, "type": data_type, "nullable": nullable == "Y"})
    cursor.close(); conn.close()
    output = {
        "table": TARGET_TABLE,
        "total_columns_found": len(all_columns),
        "columns_removed_by_filter": filtered_out,
        "safe_columns_count": len(safe_columns),
        "safe_columns": safe_columns
    }
    with open("schema_whitelist.json", "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\nDone! Total: {len(all_columns)}, Filtered: {len(filtered_out)}, Safe: {len(safe_columns)}")
    print(f"Filtered columns: {filtered_out}")
    print("Schema saved to schema_whitelist.json")

if __name__ == "__main__":
    generate_schema()
