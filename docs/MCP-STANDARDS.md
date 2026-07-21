# Oracle MCP Tool Standards

This document defines the standardization layer for all Oracle MCP tools, ensuring consistency, quality, and maintainability across the 26-tool surface.

## Architecture

### Tool Registration (`src/mcp/toolBuilder.ts`)

All tools are now registered through a standardized pipeline:

```typescript
interface ToolDefinition {
  name: string;                          // oracle_*
  category: ToolCategory;                // 'consult' | 'memory' | 'docs' | ... 
  title: string;                         // Short title
  description: string;                   // Full description
  inputSchema: z.ZodType<any>;          // Zod validation schema
  outputSchema: z.ZodType<any>;         // Output validation schema
  keywords?: string[];                   // Search keywords
  rateLimitPerMin?: number;              // Rate limiting
  cacheable?: boolean;                   // Memoization support
  handler: (input: any) => Promise<any>; // Implementation
}
```

### Error Handling (`src/mcp/oracleErrors.ts`)

Structured error codes replace string messages:

```typescript
enum ErrorCode {
  INVALID_REQUEST = "INVALID_REQUEST",      // Input validation failure
  INVALID_SKILL = "INVALID_SKILL",          // Unknown skill name
  NO_FILES = "NO_FILES",                    // File pattern matched nothing
  NOT_FOUND = "NOT_FOUND",                  // Resource not found
  PROVIDER_ERROR = "PROVIDER_ERROR",        // LLM provider issue
  // ... 15 total codes
}

throw new OracleToolError(
  ErrorCode.INVALID_SKILL,
  "Unknown skill: javascript-review",
  "Available: review, debug, security, ..."
);
```

All errors serialize to `{ code, message, detail, context }` for programmatic handling.

### Caching Layer (`src/mcp/toolCache.ts`)

Memoizes expensive operations (skill lookup, docs search, wiki builds):

```typescript
const cache = new ToolCache(); // 5min default TTL

// Auto-compute & cache
const skills = await cache.getOrCompute(
  "skills-list",
  () => skillRegistry.list(),
  5 * 60 * 1000
);

// Invalidate on updates
cache.invalidatePattern("skill-.*");
```

## Tool Categories

### 1. Ask & Agent (2 tools)
- `oracle_ask` — Single entry point for Q&A: freeform question, or "look at these files and tell me X" when `files` is passed
- `oracle_agent` — Autonomous coding loop: reads/writes/edits files, searches, and runs shell commands in a tool-use loop until the task is done (see [`AGENT.md`](AGENT.md))

**Standards (`oracle_ask`):**
- Question max 50KB
- File glob support with `!exclude` patterns (optional — omit for plain Q&A)
- Conversation continuity via `conversationId`
- Optional docs injection via `include_docs`
- Auto-scopes memory to an oracle profile via `oracle` (recall before, save insight after)
- Auto-injects identity + memory context

**Standards (`oracle_agent`):**
- Prompt max 50KB; `maxSteps` bounded 1..50 (default 20)
- `readOnly` drops all mutating tools (write/edit/bash) for investigation-only runs
- All filesystem tools confined to the workspace root (traversal rejected)
- Emits per-turn MCP progress notifications when a progress token is passed
- Requires an agent-capable provider (`anthropic` or `opencode`); otherwise returns `ORACLE_AGENT_UNAVAILABLE`

### 2. Memory (8 tools)
- `oracle_memory_list` — Recall entries
- `oracle_memory_search` — Full-text search
- `oracle_memory_update` — Edit entry
- `oracle_memory_stats` — Aggregate counts
- `oracle_memory_clear` — Wipe an agent's memory
- `oracle_memory_wiki_build` — Compile topic wiki
- `oracle_memory_wiki_list` — List wiki topics
- `oracle_memory_wiki_get` — Read a wiki page

**Standards:**
- All memory ops scoped to agent + workspace
- Type system: `fact | insight | chunk | working`
- Importance 0–1 (lower = more disposable)
- Cache invalidation on update/clear

### 3. Docs (4 tools)
- `oracle_docs_list` — List knowledge base files
- `oracle_docs_search` — BM25 ranked passage search
- `oracle_docs_add` — Upload file (.md, .txt, .json)
- `oracle_docs_remove` — Delete file

**Standards:**
- Stored in `.oracle/docs/` (workspace-scoped)
- Search results ranked by relevance
- Support for heading-level chunking
- Cached 10 minutes after first search

### 4. Web (3 tools)
- `oracle_web_search` — Search via Brave/Tavily/Firecrawl
- `oracle_web_fetch` — Load & extract text from URL
- `oracle_web_extract` — Structured extraction via AgentQL

**Standards:**
- Provider selection in config (fallback to first available)
- SSRF guarded (native fetcher only reads http/https)
- Results truncated to 50KB
- Timeout 30s per fetch

### 5. Identity (3 tools)
- `oracle_identity_show` — View saved profile
- `oracle_identity_setup` — Create profile
- `oracle_persona_set` — Set Oracle's tone/style

**Standards:**
- Auto-injected into all consults
- Preferences/habits/goals split on `,;` or newline
- Tones: professional | casual | friendly | witty
- Cached for session lifetime

### 6. Oracle Profiles (2 tools)
- `oracle_oracle_list` — List registered profiles
- `oracle_oracle_register` — Create skill+model+memory bundle

**Standards:**
- Profiles combine skill + model override + memory flag
- Cached 5 minutes
- Can enable auto-memory for specific profiles

### 7. Session (3 tools)
- `oracle_sessions` — List recent consults
- `oracle_session_get` — Fetch session + output
- `oracle_skills` — List available skills

**Standards:**
- Sessions persist indefinitely (queryable by sessionId)
- Output truncated to last 100KB in listings
- Skill list includes name + description + model override

### 8. Util (1 tool)
- `oracle_doctor` — Verify config + provider health

**Standards:**
- Non-blocking diagnostics
- Checks: Node.js version, config, workspace, provider auth
- Returns structured `{ healthy: boolean, checks: [...] }`

## Input Validation

All inputs use Zod validators with `.describe()` for every field:

```typescript
inputSchema: {
  question: z
    .string()
    .min(1)
    .max(50000)
    .describe("The question or what you're stuck on"),
  oracle: z
    .string()
    .optional()
    .describe("Oracle profile name (e.g. 'coding'). Auto-scopes memory to this profile"),
  files: z
    .array(z.string())
    .optional()
    .describe("File glob patterns to include when the answer needs real code"),
}
```

**Rules:**
- All string fields: min/max bounds
- All enums: exhaustive, no fallback to unknown
- Arrays: min/max length
- Numbers: min/max + step if applicable
- Field descriptions: >10 words, concrete examples

## Output Response Format

All tools return:

```typescript
{
  success: boolean,
  data?: any,                         // Payload (on success)
  error?: string,                     // Error message (on failure)
  metadata?: Record<string, unknown>  // Stats, session IDs, etc.
}
```

Example:
```json
{
  "success": true,
  "data": {
    "output": "Analysis result...",
    "sessionId": "session-123",
    "filesIncluded": 42
  },
  "metadata": {
    "provider": "claude-opus",
    "preset": "security"
  }
}
```

## Rate Limiting & Caching

| Tool | Rate Limit | Cacheable | TTL |
|---|---|---|---|
| `oracle_ask` | 10/min | No | — |
| `oracle_agent` | 5/min | No | — |
| `oracle_memory_*` | — | Yes (update clears) | 5min |
| `oracle_docs_search` | 20/min | Yes | 10min |
| `oracle_web_*` | 5/min | Yes (fetch) | 30min |
| `oracle_identity_*` | — | Yes | session |
| `oracle_skills` | — | Yes | 5min |
| `oracle_doctor` | — | No | — |

## Error Handling Checklist

- [ ] Validate all inputs before processing
- [ ] Throw `OracleToolError` with specific `ErrorCode`
- [ ] Include `detail` field with remediation hint
- [ ] Attach `context` object (e.g., available skills, matched files)
- [ ] Never expose provider secrets or workspace paths in errors
- [ ] Log to MCP stderr for debugging

Example:
```typescript
if (!skillRegistry.has(skillName)) {
  throw new OracleToolError(
    ErrorCode.INVALID_SKILL,
    `Unknown skill: ${skillName}`,
    `Run oracle_skills to see available options`,
    { available: skillRegistry.names() }
  );
}
```

## Tool Module Structure

New tools go in `src/mcp/tools/<category>.ts`:

```
src/mcp/tools/
  ├── consult.ts    (oracle_ask)
  ├── memory.ts     (oracle_memory_*, oracle_memory_wiki_*)
  ├── docs.ts       (oracle_docs_*)
  ├── web.ts        (oracle_web_*)
  ├── identity.ts   (oracle_identity_*, oracle_persona_set)
  ├── oracle.ts     (oracle_oracle_*)
  ├── session.ts    (oracle_sessions, oracle_session_get, oracle_skills)
  └── util.ts       (oracle_doctor)
```

Each module exports a `createToolDefinitions()` function, registered in server.ts:

```typescript
const toolDefs = [
  ...createConsultTools(),
  ...createMemoryTools(),
  ...createDocsTools(),
  // ...
];
registry.registerAll(server);
```

## Migration Guide (Legacy → Standardized)

**Old pattern:**
```typescript
server.registerTool("oracle_example", {
  title: "...",
  description: "...",
  inputSchema: { prompt: z.string() } // no .describe()
}, async ({ prompt }) => {
  try { /* logic */ } catch (e) { return failure(e); }
});
```

**New pattern:**
```typescript
const toolDef: ToolDefinition = {
  name: "oracle_example",
  category: "consult",
  title: "...",
  description: "...",
  inputSchema: z.object({
    prompt: z.string().describe("The prompt text")
  }),
  outputSchema: z.object({
    success: z.boolean(),
    data: z.object({ result: z.string() }).optional()
  }),
  handler: async ({ prompt }) => {
    if (!prompt.trim()) {
      throw new OracleToolError(
        ErrorCode.INVALID_REQUEST,
        "Prompt cannot be empty"
      );
    }
    return toolSuccess({ result: "..." });
  }
};
```

## Testing

All tools pass:
- ✅ Type check (`tsc --noEmit`)
- ✅ Build (`npm run build`)
- ✅ Unit tests (`npm test`)
- ✅ Input validation (Zod schemas enforced)
- ✅ Error scenarios (bad skill name, no files, etc.)

Before shipping a new tool:
```bash
npm run typecheck
npm run build
npm test  
# Verify the tool manually via oracle_doctor + oracle-mcp
```

---

**Last updated:** 2026-07-20  
**Tool count:** 26  
**MCP version:** OpenAI-compatible (MCP SDK 0.8+)
