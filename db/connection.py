import json
import oracledb
from db.init_client import init_client

def load_config(path="config/db_config.json"):
    with open(path) as f:
        return json.load(f)

def get_connection():
    config = load_config()
    init_client(config["lib_dir"])

    return oracledb.connect(
        user=config["username"],
        password=config["password"],
        dsn=config["dsn"]
    )
