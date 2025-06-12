import oracledb
import json

def init_client(lib_dir: str):
    try:
        oracledb.init_oracle_client(lib_dir=lib_dir)
        print(f"✅ Oracle Client initialized at {lib_dir}")
    except Exception as e:
        print("❌ Failed to initialize Oracle Client:", e)
