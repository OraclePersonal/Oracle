# Oracle Ecosystem Architecture

## Ports

| Service | Port | Protocol |
|---------|------|----------|
| oracle-memory HTTP | 8765 | HTTP/MCP |
| oracle-messages HTTP | 8770 | HTTP/MCP |
| oracle-dashboard | 3456 | HTTP |

## Database Ports

| Database | Default Port |
|----------|-------------|
| PostgreSQL | 5432 |
| Redis | 6379 |
| MySQL | 3306 |
| MongoDB | 27017 |

## Environment Variables

Set these in `.env` or `settings.json`:
- `ORACLE_USE_OLLAMA=1` — enable semantic memory search
- `OPENCODE_API_KEY` — API key for opencode provider
- `OPENCODE_API_BASE` — base URL for OpenAI-compatible API
- `OPENCODE_MODEL` — model name (default: gpt-4o)
