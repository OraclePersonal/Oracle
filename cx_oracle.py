import cx_Oracle
import os

# ระบุ path Oracle Instant Client ก่อน import
oracle_client_path = r"C:\oracle\instantclient_19_26"
os.environ["PATH"] = oracle_client_path + ";" + os.environ["PATH"]

# แล้วจึง import
cx_Oracle.init_oracle_client(lib_dir=oracle_client_path)

# ทดสอบ client version
print("Oracle Client Version:", cx_Oracle.clientversion())
