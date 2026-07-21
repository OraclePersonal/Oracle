---
title: Architecture
---

# Architecture

Oracle sits at the center of the ecosystem — the orchestration layer over memory, docs, web providers, messaging, locks, and personas.

```
you ──▶ oracle ask ──▶ context (memory · docs · web · files) ──▶ think (AI) ──▶ answer
              │                                                                  │
     conversation continuity                                          remembers what it said
              │                                                                  │
     memory (facts · insights · wiki)  ◀───────────────────▶  mesh (locks · messages)
```

## Components

| Component | Responsibility |
|-----------|----------------|
| **CLI** | Commander-based CLI: ask, consult, watch, web, docs, peer, wiki |
| **MCP Server** | Stdio MCP server exposing 45 tools |
| **ConsultService** | Core loop: load files → build context → call provider → answer |
| **Provider layer** | Codex CLI, Anthropic, OpenAI, OpenCode |
| **Memory adapter** | Connects to oracle-memory (subprocess or file fallback) |
| **Messages adapter** | Connects to oracle-messages (subprocess or file fallback) |
| **Web providers** | Brave, Tavily, Firecrawl, AgentQL |
| **Skills** | Five built-in + custom loading |
| **Wiki** | Compile memory into topic-grouped pages |
| **Soul prompts** | Personality system from ~/.oracle/souls/ |
| **Identity** | Profile store and persona management |

## Provider routing

| Provider | Auth |
|----------|------|
| codex (default) | Codex CLI login |
| anthropic | ANTHROPIC_API_KEY |
| openai | OPENAI_API_KEY |
| opencode | OPENCODE_API_KEY |

## Layout

```
~/.oracle/
├── oracles/           # named profiles
├── skills/            # custom skills
├── souls/             # soul prompts
├── sessions/<id>/     # consult history
└── auth/              # provider tokens

<project>/
├── .oracle/config.json
├── .oracle-memory/    # facts · insights · chunks · working
└── .oracle/messages/  # shared mailbox
```