---
title: On-Disk Layout
---

# On-Disk Layout

All data is stored under `<root>/.oracle-memory/`.

```
<root>/.oracle-memory/
├── config.json              # Server metadata (created, version)
├── facts/                   # Permanent knowledge
│   └── 20260713-120000-....json
├── insights/                # Lessons learned
│   └── 20260713-120001-....json
├── chunks/                  # Conversation snapshots (TTL-expiring)
│   └── 20260713-120002-....json
├── working/                 # Session scratchpad (auto-cleared)
│   └── 20260713-120003-....json
├── graph/
│   └── graph.json           # Entity relationship graph
└── vectors/                 # Vector embeddings (optional)
    └── (vectra index files)
```

## Entry files

Each memory is a single JSON file named `{id}.json`. Example:

```json
{
  "id": "20260713-120000-000000-a1b2c3d4e5f6",
  "ts": "2026-07-13T12:00:00.000Z",
  "agent": "claude",
  "type": "insight",
  "content": "Use environment variables for database config",
  "tags": ["database", "config", "security"],
  "importance": 0.72,
  "ttl": 604800
}
```

## Atomic writes

All file writes follow a two-phase protocol:
1. Write to `{path}.tmp`
2. Rename `.tmp` → original path

This prevents corruption from crashes or power loss.

## Entity graph

The entity graph (`graph/graph.json`) stores extracted entities and their
relationships. It's an adjacency list format with entities connected by
typed edges ("uses", "implements", "depends_on", "related_to").

## Vector store

When vector search is enabled, `.oracle-memory/vectors/` is managed by Vectra.
It contains serialized index files and the ONNX model cache for
`Xenova/all-MiniLM-L6-v2`.
