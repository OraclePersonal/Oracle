from db.query_runner import run_query

def main():
    sql = "SELECT * FROM v$version"
    rows = run_query(sql)
    for row in rows:
        print(row)

if __name__ == "__main__":
    main()
