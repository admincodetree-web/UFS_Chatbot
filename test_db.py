import os
import oracledb
from dotenv import load_dotenv

load_dotenv()
dsn = f"{os.getenv('DB_HOST')}:{os.getenv('DB_PORT')}/{os.getenv('DB_SERVICE')}"
conn = oracledb.connect(user=os.getenv('DB_USER'), password=os.getenv('DB_PASS'), dsn=dsn)
cur = conn.cursor()

try:
    cur.execute('SELECT COUNT(*) FROM UFS_BOT')
    print('UFS_BOT count:', cur.fetchone()[0])
except Exception as e:
    print('UFS_BOT error:', e)

try:
    cur.execute('SELECT COUNT(*) FROM UFS_CITIZEN_DATA')
    print('UFS_CITIZEN_DATA count:', cur.fetchone()[0])
except Exception as e:
    print('UFS_CITIZEN_DATA error:', e)
try:
    cur.execute('SELECT COUNT(*) FROM APHH_USER.UFS_CITIZEN_DATA')
    print('APHH_USER.UFS_CITIZEN_DATA count:', cur.fetchone()[0])
except Exception as e:
    print('APHH_USER.UFS_CITIZEN_DATA error:', e)
