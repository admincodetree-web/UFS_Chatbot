import os
import oracledb
from dotenv import load_dotenv

load_dotenv()
dsn = f"{os.getenv('DB_HOST')}:{os.getenv('DB_PORT')}/{os.getenv('DB_SERVICE')}"
conn = oracledb.connect(user=os.getenv('DB_USER'), password=os.getenv('DB_PASS'), dsn=dsn)
cur = conn.cursor()

try:
    cur.execute("SELECT TABLE_NAME FROM ALL_TABLES WHERE TABLE_NAME LIKE 'UFS_CITIZE%'")
    tables = cur.fetchall()
    print("Found tables:", tables)
except Exception as e:
    print("Error:", e)
