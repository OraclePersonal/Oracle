#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { VERSION } from "./version.js";
import { ConsultService } from "./core/consult.js";
import {
  checkProvider,
  createProvider,
  createAgentProvider,
  parseProviderName
} from "./providers/factory.js";
import { AgentService } from "./agent/service.js";
import { FileSessionStore } from "./session/store.js";
import {
  ensureProjectConfig,
  generateMcpSetup,
  writeMcpSetup,
  type McpClient
} from "./setup/mcp.js";
import { AnthropicOAuthClient } from "./auth/anthropic-oauth.js";
import { TokenStore } from "./auth/store.js";
import { SkillRegistry } from "./skills/registry.js";
import { OracleRegistry } from "./oracles/registry.js";
import { OrchestratorFactory } from "./orchestrator/factory.js";
import { DEFAULT_SYSTEM_PROMPT } from "./context/bundle.js";
import { ProfileStore } from "./identity/profile.js";
import * as gh from "./github/gh.js";
import type { PRFile } from "./github/types.js";
import { listDocs, searchDocs, addDoc, removeDoc } from "./docs/reader.js";
import { webSearchWithTrace } from "./web/search.js";
import { fetchUrl } from "./web/fetchUrl.js";
import { agentqlExtract } from "./web/providers/agentql.js";
import { loadSoul } from "./core/souls.js";
import { buildOracleSystemPrompt } from "./core/systemPrompt.js";
import { getConversationContext, recordSelfLog } from "./core/selfMemory.js";
import { buildWiki, getWikiPage, listWikiTopics } from "./wiki/compile.js";

const homeDir = (): string =>
  process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");

const program = new Command()
  .name("oracle")
  .description("Oracle — MCP-powered AI coding consultant")
  .version(VERSION);

// ── ask ──────────────────────────────────────────────────────────
program
  .command("ask")
  .description("Ask Oracle anything, one entry point — pass -f to also look at code")
  .argument("<question>", "Your question")
  .option("--soul <name>", "Soul prompt name (~/.oracle/souls/<name>.md)")
  .option("-f, --file <pattern...>", "File paths or glob patterns to include")
  .option("--conversation <id>", "Stable id so Oracle recalls what it already told you across calls")
  .option("--include-docs", "Search .oracle/docs/ for relevant documentation")
  .option("-m, --model <model>", "Model override")
  .option("--provider <provider>", "Provider override")
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (question, options) => {
    const cwd = path.resolve(options.cwd);
    const finalProvider = options.provider ?? "codex";
    const parsedProvider = parseProviderName(finalProvider);
    const checks = await checkProvider(parsedProvider);
    const failedCheck = checks.find((chk) => !chk.ok);
    if (failedCheck) throw new Error(`${failedCheck.name}: ${failedCheck.detail}`);

    const service = new ConsultService(createProvider(parsedProvider));
    const soulsDir = path.join(homeDir(), "souls");

    // Build system prompt — use specific soul if --soul given, otherwise auto-detect mood
    const soulPrompt = options.soul ? await loadSoul(options.soul, soulsDir) : undefined;
    const systemPrompt = buildOracleSystemPrompt(soulPrompt);

    const orchestrator = new OrchestratorFactory(cwd, homeDir());
    const memory = await orchestrator.createMemoryAdapter();

    let ctxBlock = "";
    if (options.conversation) {
      ctxBlock += await getConversationContext(memory, options.conversation);
    }
    if (options.includeDocs) {
      const matched = await searchDocs(cwd, question, 5);
      if (matched.length > 0) {
        const docsBlock = matched.map((d) => `### ${d.name}${d.heading ? ` — ${d.heading}` : ""}\n${d.snippet}`).join("\n\n");
        ctxBlock += `\n\n## Documentation from .oracle/docs/\n${docsBlock}`;
      }
    }

    const hasFiles = Boolean(options.file?.length);
    const result = await service.consult({
      prompt: `${ctxBlock}\n\n## Question\n${question}`,
      preset: "review",
      provider: finalProvider,
      files: hasFiles ? options.file : [],
      model: options.model ?? "gpt-5.4",
      cwd,
      systemPrompt,
      allowEmptyFiles: !hasFiles
    });

    if (options.conversation) {
      await recordSelfLog(memory, options.conversation, { question, answerSummary: result.output.slice(0, 400) });
    }

    console.log(result.output);
    process.exitCode = result.status === "completed" ? 0 : 1;
  });

// ── oracle ───────────────────────────────────────────────────────
program
  .command("agent")
  .description("Autonomously carry out a coding task with a tool-use loop")
  .argument("<task>", "The task to carry out")
  .option("--provider <provider>", "Provider override (agent needs anthropic or opencode)")
  .option("-m, --model <model>", "Model override", "auto")
  .option("--read-only", "Investigate only")
  .option("--max-steps <n>", "Max agent turns before stopping", "20")
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (task, options) => {
    const cwd = path.resolve(options.cwd);
    const parsedProvider = parseProviderName(options.provider ?? "anthropic");
    const checks = await checkProvider(parsedProvider);
    const failedCheck = checks.find((chk) => !chk.ok);
    if (failedCheck) throw new Error(`${failedCheck.name}: ${failedCheck.detail}`);
    const agent = new AgentService(createAgentProvider(parsedProvider));
    const result = await agent.run({
      prompt: task,
      workspaceRoot: cwd,
      model: options.model,
      readOnly: Boolean(options.readOnly),
      maxSteps: Number(options.maxSteps),
      onStep: (step) => console.error(`[turn ${step.turn}] ${step.toolsUsed.join(", ") || "done"}`)
    });
    console.log(result.finalText);
    if (result.stoppedOnLimit) console.error(`Stopped after ${options.maxSteps} turns.`);
  });

const oracleCmd = program.command("oracle").description("Manage oracle profiles");

oracleCmd
  .command("list")
  .description("List registered oracles")
  .action(async () => {
    const reg = new OracleRegistry(homeDir());
    const list = await reg.listOracles();
    if (!list.length) { console.log("No oracles registered."); return; }
    for (const o of list) {
      const mem = o.memory ? " +memory" : "";
      console.log(`${o.name.padEnd(20)} skill=${o.skill}${mem}`);
    }
  });

oracleCmd
  .command("register")
  .description("Register a new oracle profile")
  .requiredOption("-n, --name <name>", "Oracle name")
  .requiredOption("-s, --skill <skill>", "Assigned skill")
  .option("-d, --description <text>", "Description")
  .option("-m, --model <model>", "Default model")
  .option("-p, --provider <provider>", "Default provider")
  .option("--memory", "Enable memory", false)
  .action(async (options) => {
    const reg = new OracleRegistry(homeDir());
    await reg.registerOracle({
      name: options.name,
      skill: options.skill,
      description: options.description,
      model: options.model,
      provider: options.provider,
      memory: options.memory
    });
    console.log(`Registered oracle: ${options.name}`);
  });

oracleCmd
  .command("unregister")
  .description("Remove an oracle profile")
  .argument("<name>", "Oracle name")
  .action(async (name) => {
    const reg = new OracleRegistry(homeDir());
    await reg.unregisterOracle(name);
    console.log(`Unregistered oracle: ${name}`);
  });

oracleCmd
  .command("show")
  .description("Show oracle profile details")
  .argument("<name>", "Oracle name")
  .action(async (name) => {
    const reg = new OracleRegistry(homeDir());
    const profile = await reg.getOracle(name);
    if (!profile) throw new Error(`Oracle not found: ${name}`);
    console.log(JSON.stringify(profile, null, 2));
  });

// ── memory ───────────────────────────────────────────────────────
const memCmd = program.command("memory").description("Manage oracle memory");

memCmd
  .command("list")
  .description("Show memory entries for an agent")
  .argument("[agent]", "Agent name (default: all)")
  .option("-n, --limit <number>", "Entries", "10")
  .action(async (agent, options) => {
    const orchestrator = new OrchestratorFactory(process.cwd(), homeDir());
    const memory = await orchestrator.createMemoryAdapter();
    const entries = await memory.recall({ agent: agent ?? undefined, limit: Number(options.limit) });
    if (!entries.length) { console.log("No memory entries."); return; }
    for (const e of entries) {
      console.log(`${e.ts.slice(0, 19)}  [${e.type.padEnd(8)}]  ${e.agent.padEnd(12)}  ${e.content.slice(0, 60)}`);
    }
  });

memCmd
  .command("clear")
  .description("Clear working memory for an agent (or all)")
  .argument("[agent]", "Agent name (omit for all)")
  .action(async (agent) => {
    const orchestrator = new OrchestratorFactory(process.cwd(), homeDir());
    const memory = await orchestrator.createMemoryAdapter();
    const count = await memory.clearWorking(agent ?? undefined);
    console.log(`Cleared ${count} working memory entries.`);
  });

const wikiCmd = program.command("wiki").description("Compile facts/insights into a topic-grouped memory wiki");

wikiCmd
  .command("build")
  .description("Compile all facts/insights into .oracle/wiki/<topic>.md + an index")
  .action(async () => {
    const cwd = process.cwd();
    const orchestrator = new OrchestratorFactory(cwd, homeDir());
    const memory = await orchestrator.createMemoryAdapter();
    const result = await buildWiki(memory, cwd);
    console.log(`Compiled ${result.topics.length} topic(s) → ${result.path}`);
  });

wikiCmd
  .command("list")
  .description("List compiled wiki topics")
  .action(async () => {
    const topics = await listWikiTopics(process.cwd());
    if (!topics.length) { console.log("No wiki topics yet — run `oracle wiki build` first."); return; }
    for (const t of topics) console.log(t);
  });

wikiCmd
  .command("show")
  .description("Print a compiled wiki topic page")
  .argument("<topic>", "Topic name")
  .action(async (topic) => {
    const page = await getWikiPage(process.cwd(), topic);
    if (!page) { console.log(`Topic not found: ${topic}. Run \`oracle wiki build\` or \`oracle wiki list\`.`); process.exitCode = 1; return; }
    console.log(page);
  });

// ── docs ─────────────────────────────────────────────────────────
const docsCmd = program.command("docs").description("Manage .oracle/docs/ knowledge base");

docsCmd
  .command("list")
  .description("List files in .oracle/docs/")
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (options) => {
    const docs = await listDocs(path.resolve(options.cwd));
    if (!docs.length) { console.log("No docs found in .oracle/docs/."); return; }
    for (const d of docs) {
      console.log(`${d.name.padEnd(40)} ${(d.size / 1024).toFixed(1)}KB`);
    }
  });

docsCmd
  .command("search")
  .description("BM25-ranked passage search over .oracle/docs/")
  .argument("<query>", "Search query")
  .option("-n, --limit <number>", "Max results", "10")
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (query, options) => {
    const results = await searchDocs(path.resolve(options.cwd), query, Number(options.limit));
    if (!results.length) { console.log("No matches."); return; }
    for (const r of results) {
      console.log(`${r.name}${r.heading ? ` — ${r.heading}` : ""}  (score ${r.score.toFixed(2)})`);
      console.log(`  ${r.snippet.slice(0, 150).replace(/\n/g, " ")}...`);
    }
  });

docsCmd
  .command("add")
  .description("Add or overwrite a file in .oracle/docs/")
  .argument("<name>", "Relative filename, e.g. 'auth/oauth.md'")
  .requiredOption("-f, --file <path>", "Source file to copy content from")
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (name, options) => {
    const content = await fs.readFile(options.file, "utf8");
    const filePath = await addDoc(path.resolve(options.cwd), name, content);
    console.log(`Added ${filePath}`);
  });

docsCmd
  .command("remove")
  .description("Delete a file from .oracle/docs/")
  .argument("<name>", "Relative filename")
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (name, options) => {
    const removed = await removeDoc(path.resolve(options.cwd), name);
    console.log(removed ? `Removed ${name}` : `Not found: ${name}`);
  });

// ── web ──────────────────────────────────────────────────────────
const webCmd = program.command("web").description("Web search, fetch, and extract (Brave/Tavily/Firecrawl/AgentQL)");

webCmd
  .command("search")
  .description("Search the web — uses the first provider with a configured API key unless --provider is given")
  .argument("<query>", "Search query")
  .option("-n, --limit <number>", "Max results", "5")
  .option("--provider <provider>", "brave | tavily | firecrawl")
  .option("--trace", "Print the provider routing/fallback chain")
  .action(async (query, options) => {
    const outcome = await webSearchWithTrace(query, Number(options.limit), options.provider);
    if (options.trace) {
      for (const a of outcome.attempts) {
        console.error(`[${a.provider}] ${a.reason} → ${a.outcome} (${a.latencyMs}ms)${a.errorMessage ? `: ${a.errorMessage}` : ""}`);
      }
    }
    if (!outcome.results.length) { console.log("No results."); return; }
    for (const r of outcome.results) {
      console.log(`${r.title}\n  ${r.url}\n  ${r.description}\n`);
    }
  });

webCmd
  .command("fetch")
  .description("Fetch a URL and print its readable text")
  .argument("<url>", "URL to fetch")
  .option("--provider <provider>", "native | firecrawl", "native")
  .action(async (url, options) => {
    const page = await fetchUrl(url, options.provider);
    if (page.title) console.log(`# ${page.title}\n`);
    console.log(page.text);
  });

webCmd
  .command("extract")
  .description("Extract structured data from a URL via TinyFish's AgentQL API")
  .argument("<url>", "URL to extract from")
  .argument("<prompt>", "What to extract, e.g. 'the product name and price'")
  .action(async (url, prompt) => {
    const result = await agentqlExtract(url, prompt);
    console.log(JSON.stringify(result.data, null, 2));
    console.error(`\nSource: ${result.sourceUrl}`);
  });

// ── existing commands ────────────────────────────────────────────
program
  .command("doctor")
  .option("--provider <provider>", "Provider: codex, openai, anthropic, or opencode", "codex")
  .action(async (options) => {
    const checks = await checkProvider(parseProviderName(options.provider));
    for (const check of checks) {
      console.log(`${check.ok ? "OK" : "FAIL"}  ${check.name}: ${check.detail}`);
    }
    process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
  });

program
  .command("setup-mcp")
  .option("--client <client>", "Client: claude-code or codex", "claude-code")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--print", "Print generated configuration without writing")
  .option("--force", "Replace an existing configuration")
  .action(async (options) => {
    if (options.client !== "claude-code" && options.client !== "codex") {
      throw new Error("Expected --client claude-code or codex.");
    }
    const serverPath = fileURLToPath(new URL("./mcp.js", import.meta.url));
    const file = generateMcpSetup({
      root: path.resolve(options.cwd),
      client: options.client as McpClient,
      serverPath
    });
    if (options.print) {
      console.log(file.content.trimEnd());
      return;
    }
    const projectConfigPath = await ensureProjectConfig(path.resolve(options.cwd));
    await writeMcpSetup(file, options.force);
    console.log(`Created ${projectConfigPath}`);
    console.log(`Created ${file.path}`);
  });

program
  .command("session")
  .argument("<id>", "Session id")
  .action(async (id) => {
    const record = await new FileSessionStore().read(id);
    if (!record) {
      console.error(`Session not found: ${id}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(record, null, 2));
  });

program
  .command("status")
  .option("-n, --limit <number>", "Number of sessions", "20")
  .action(async (options) => {
    const records = await new FileSessionStore().list(Number(options.limit));
    for (const item of records) {
      console.log(
        `${item.createdAt}  ${item.status.padEnd(9)}  ${item.model.padEnd(16)}  ${item.sessionId}`
      );
    }
  });

program
  .command("login")
  .description("Authenticate with an OAuth provider")
  .option("--provider <provider>", "Provider", "anthropic")
  .option("--client-id <id>", "OAuth client ID")
  .option("--force", "Re-authenticate")
  .action(async (options) => {
    const store = new TokenStore(homeDir());
    const existing = await store.read(options.provider);
    if (existing && !options.force) {
      console.log(`Already logged in to ${options.provider}. Use --force to re-authenticate.`);
      return;
    }
    if (options.provider !== "anthropic") throw new Error(`Login not supported for provider: ${options.provider}`);
    const clientId = options.clientId ?? process.env.ANTHROPIC_CLIENT_ID;
    if (!clientId) throw new Error("ANTHROPIC_CLIENT_ID is required.");
    const oauth = new AnthropicOAuthClient(clientId, store);
    const session = await oauth.startDeviceFlow();
    console.log(`\nOpen: ${session.verificationUri}\nCode: ${session.userCode}\n`);
    console.log("Waiting for authorization...");
    await oauth.pollForToken(session.deviceCode, session.interval);
    const tier = await oauth.getPlanTier();
    console.log(`Authenticated. Plan: ${tier}`);
  });

program
  .command("logout")
  .description("Clear OAuth session")
  .option("--provider <provider>", "Provider", "anthropic")
  .action(async (options) => {
    await new TokenStore(homeDir()).delete(options.provider);
    console.log(`Logged out of ${options.provider}.`);
  });

program
  .command("skill")
  .description("Manage skills")
  .argument("[action]", "list, install", "list")
  .argument("[arg]", "Skill name or file path")
  .action(async (action, arg) => {
    const reg = new SkillRegistry(homeDir());
    await reg.load();
    if (action === "list") {
      for (const skill of reg.list()) {
        console.log(`${skill.name.padEnd(20)} ${skill.description}`);
      }
    } else if (action === "install") {
      if (!arg) throw new Error("Usage: oracle skill install <file.json>");
      const name = await reg.install(arg);
      console.log(`Installed skill: ${name}`);
    } else {
      throw new Error(`Unknown action: ${action}. Use list or install.`);
    }
  });

// ── identity ────────────────────────────────────────────────────
const identityCmd = program.command("identity").description("Manage your personal identity");

identityCmd
  .command("show")
  .description("Show identity profile")
  .action(async () => {
    const store = new ProfileStore(homeDir());
    const identity = await store.getIdentity();
    const persona = await store.getPersona();
    console.log("Persona:", JSON.stringify(persona, null, 2));
    console.log("Identity:", JSON.stringify(identity ?? "not set", null, 2));
  });

identityCmd
  .command("setup")
  .description("Set up your identity profile")
  .requiredOption("-n, --name <name>", "Your name")
  .option("--title <title>", "Your title")
  .option("--role <role>", "Your role")
  .option("-d, --description <text>", "About you")
  .option("--prefs <items>", "Preferences (comma-separated)")
  .option("--habits <items>", "Habits (comma-separated)")
  .option("--goals <items>", "Goals (comma-separated)")
  .action(async (options) => {
    const store = new ProfileStore(homeDir());
    await store.saveIdentity({
      name: options.name,
      title: options.title,
      role: options.role,
      description: options.description,
      preferences: options.prefs?.split(",").map((s: string) => s.trim()),
      habits: options.habits?.split(",").map((s: string) => s.trim()),
      goals: options.goals?.split(",").map((s: string) => s.trim())
    });
    console.log(`Identity saved for ${options.name}. Every consult now knows who you are.`);
  });

identityCmd
  .command("persona")
  .description("Set Oracle's voice/personality")
  .option("--name <name>", "Oracle's name", "Oracle")
  .option("--tone <tone>", "professional | casual | friendly | witty", "professional")
  .option("--style <text>", "Custom style description")
  .option("--greeting <text>", "Greeting message")
  .action(async (options) => {
    const store = new ProfileStore(homeDir());
    await store.savePersona({
      name: options.name,
      tone: options.tone,
      style: options.style,
      greeting: options.greeting
    });
    console.log(`Persona saved: ${options.name}`);
  });

identityCmd
  .command("forget")
  .description("Clear your identity profile")
  .action(async () => {
    const store = new ProfileStore(homeDir());
    await store.saveIdentity({ name: "" });
    console.log("Identity cleared.");
  });

// ── github ────────────────────────────────────────────────────
const githubCmd = program.command("github").description("GitHub integration via gh CLI");

githubCmd
  .command("check")
  .description("Check gh CLI installation and authentication")
  .action(() => {
    const inst = gh.checkGh();
    if (!inst.ok) {
      console.error("gh CLI not found. Install from https://cli.github.com/");
      process.exitCode = 1;
      return;
    }
    console.log(`gh: ${inst.version}`);
    const auth = gh.checkGhAuth();
    if (auth.ok) {
      console.log(`Authenticated as: ${auth.user}`);
    } else {
      console.error(`Not authenticated: ${auth.error}`);
      console.error("Run: gh auth login");
      process.exitCode = 1;
    }
  });

githubCmd
  .command("pr")
  .description("Pull request operations")
  .argument("<action>", "list | view | diff | files | review | comment | approve | request-changes")
  .argument("[number]", "PR number (required for view/diff/files/review/comment/approve/request-changes)")
  .option("-R, --repo <repo>", "Repository (owner/repo)")
  .option("-s, --state <state>", "PR state filter: open | closed | merged | all (default: open)")
  .option("-b, --body <text>", "Comment/review body")
  .option("--base <branch>", "Filter by base branch")
  .option("--head <branch>", "Filter by head branch")
  .option("-n, --limit <number>", "Max results", "30")
  .option("--author <author>", "Filter by author")
  .option("--label <labels>", "Filter by labels (comma-separated)")
  .action(async (action: string, number: string, options) => {
    const repo = options.repo ?? gh.inferRepo(options.cwd ?? process.cwd());
    const num = number ? Number(number) : undefined;
    switch (action) {
      case "list": {
        const prs = gh.listPRs({
          repo,
          state: options.state as any,
          limit: Number(options.limit),
          base: options.base,
          head: options.head,
          author: options.author,
          labels: options.label?.split(","),
        });
        if (!prs.length) { console.log("No PRs found."); return; }
        for (const pr of prs) {
          const s = pr.state === "open" ? "\x1b[32mopen\x1b[0m" : pr.state === "merged" ? "\x1b[35mmerged\x1b[0m" : "\x1b[31mclosed\x1b[0m";
          console.log(`#${String(pr.number).padEnd(4)} ${s}  ${pr.title}`);
        }
        break;
      }
      case "view":
        if (!num) throw new Error("PR number required");
        {
          const pr = gh.getPR(num, repo);
          console.log(`#${pr.number} ${pr.title}`);
          console.log(`State: ${pr.state}  Author: ${pr.author}`);
          console.log(`Base: ${pr.baseRef} ← Head: ${pr.headRef}`);
          console.log(`Created: ${pr.createdAt.slice(0, 10)}`);
          if (pr.body) console.log(`\n${pr.body.slice(0, 2000)}`);
        }
        break;
      case "diff":
        if (!num) throw new Error("PR number required");
        console.log(gh.getPRDiff(num, repo));
        break;
      case "files":
        if (!num) throw new Error("PR number required");
        {
          const files = gh.getPRFiles(num, repo);
          let add = 0, del = 0;
          for (const f of files) { add += f.additions; del += f.deletions; }
          console.log(`${files.length} file(s), +${add} -${del}\n`);
          for (const f of files) {
            const icon = f.status === "added" ? "\x1b[32m+\x1b[0m" : f.status === "removed" ? "\x1b[31m-\x1b[0m" : f.status === "renamed" ? "\x1b[33m→\x1b[0m" : "\x1b[34m~\x1b[0m";
            console.log(` ${icon} ${f.path}  (+${f.additions}, -${f.deletions})`);
          }
        }
        break;
      case "review":
        if (!num) throw new Error("PR number required");
        {
          const pr = gh.getPR(num, repo);
          const diff = gh.getPRDiff(num, repo);
          const files = gh.getPRFiles(num, repo);
          console.log(`\nReviewing PR #${num}: ${pr.title}`);
          console.log(`Repository: ${repo ?? "unknown"}`);
          console.log(`Files: ${files.length}, Diff: ${(diff.length / 1024).toFixed(1)}KB\n`);

          const fileList = files.map((f: PRFile) => `  ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`).join("\n");
          const reviewPrompt = [
            `## PR Review: #${num} — ${pr.title}`,
            `**Author:** ${pr.author}  **Repo:** ${repo}`,
            `**Base:** ${pr.baseRef} ← **Head:** ${pr.headRef}`,
            "",
            pr.body ? `### Description\n${pr.body}\n` : "",
            `### Changed Files (${files.length})`,
            fileList,
            "",
            "### Diff",
            "```diff",
            diff.slice(0, 50000),
            "```",
            "",
            "Review this PR for correctness, edge cases, security, and maintainability.",
            "Be specific — cite line numbers from the diff.",
          ].filter(Boolean).join("\n");

          const { ConsultService } = await import("./core/consult.js");
          const { createProvider, parseProviderName } = await import("./providers/factory.js");
          const providerName = options.provider ?? "codex";
          const parsedProvider = parseProviderName(providerName);
          const checks = await (await import("./providers/factory.js")).checkProvider(parsedProvider);
          const failedCheck = checks.find((chk: any) => !chk.ok);
          if (failedCheck) throw new Error(`${failedCheck.name}: ${failedCheck.detail}`);

          const service = new ConsultService(createProvider(parsedProvider));
          const result = await service.consult({
            prompt: reviewPrompt,
            preset: "review",
            provider: providerName,
            model: options.model ?? "gpt-5.4",
            cwd: options.cwd ?? process.cwd(),
            systemPrompt: "You are a senior code reviewer. Analyze the PR diff and files. Be specific, cite line numbers, and categorize findings by severity (critical/major/minor/nit). End with a verdict: approve, request changes, or comment.",
            allowEmptyFiles: true,
          });

          console.log(`\n${result.output}`);
          if (options.body) {
            gh.submitPRReview(num, options.body, "COMMENT", repo);
            console.log("\nReview posted as comment.");
          }
        }
        break;
      case "comment":
        if (!num) throw new Error("PR number required");
        if (!options.body) throw new Error("Comment body required (-b)");
        gh.createComment(num, options.body, repo);
        console.log("Comment posted.");
        break;
      case "approve":
        if (!num) throw new Error("PR number required");
        gh.submitPRReview(num, options.body ?? "LGTM.", "APPROVE", repo);
        console.log("PR approved.");
        break;
      case "request-changes":
        if (!num) throw new Error("PR number required");
        if (!options.body) throw new Error("Review body required (-b) for request-changes");
        gh.submitPRReview(num, options.body, "REQUEST_CHANGES", repo);
        console.log("Changes requested.");
        break;
      default:
        throw new Error(`Unknown action: ${action}. Use: list, view, diff, files, review, comment, approve, request-changes`);
    }
  });

githubCmd
  .command("issue")
  .description("Issue operations")
  .argument("<action>", "list | view | comment")
  .argument("[number]", "Issue number (required for view/comment)")
  .option("-R, --repo <repo>", "Repository (owner/repo)")
  .option("-s, --state <state>", "Issue state filter: open | closed | all (default: open)")
  .option("-b, --body <text>", "Comment body")
  .option("-n, --limit <number>", "Max results", "30")
  .option("--author <author>", "Filter by author")
  .option("--label <labels>", "Filter by labels (comma-separated)")
  .action(async (action: string, number: string, options) => {
    const repo = options.repo ?? gh.inferRepo(options.cwd ?? process.cwd());
    const num = number ? Number(number) : undefined;
    switch (action) {
      case "list": {
        const issues = gh.listIssues({
          repo,
          state: options.state as any,
          limit: Number(options.limit),
          author: options.author,
          labels: options.label?.split(","),
        });
        if (!issues.length) { console.log("No issues found."); return; }
        for (const i of issues) {
          const s = i.state === "open" ? "\x1b[32mopen\x1b[0m" : "\x1b[31mclosed\x1b[0m";
          console.log(`#${String(i.number).padEnd(4)} ${s}  ${i.title}`);
        }
        break;
      }
      case "view":
        if (!num) throw new Error("Issue number required");
        {
          const i = gh.getIssue(num, repo);
          console.log(`#${i.number} ${i.title}`);
          console.log(`State: ${i.state}  Author: ${i.author}`);
          console.log(`Created: ${i.createdAt.slice(0, 10)}`);
          if (i.body) console.log(`\n${i.body.slice(0, 2000)}`);
        }
        break;
      case "comment":
        if (!num) throw new Error("Issue number required");
        if (!options.body) throw new Error("Comment body required (-b)");
        gh.createComment(num, options.body, repo);
        console.log("Comment posted.");
        break;
      default:
        throw new Error(`Unknown action: ${action}. Use: list, view, comment`);
    }
  });

githubCmd
  .command("search")
  .description("Search GitHub code")
  .argument("<query>", "Search query")
  .option("-n, --limit <number>", "Max results", "10")
  .action(async (query: string, options) => {
    const results = gh.searchCode(query, Number(options.limit));
    for (const r of results) {
      console.log(`${r.repo}:${r.path}`);
      for (const m of r.matches) {
        console.log(`  ${m.slice(0, 200)}`);
      }
    }
  });

githubCmd
  .command("get")
  .description("Raw GitHub API GET request")
  .argument("<endpoint>", "API endpoint (e.g. /repos/owner/repo)")
  .action(async (endpoint: string) => {
    const result = gh.apiRequest(endpoint);
    console.log(JSON.stringify(result, null, 2));
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // A rejected command action would otherwise surface as a top-level
  // unhandled rejection: Node prints the raw stack and, because orchestrated
  // commands may leave an MCP HTTP transport/socket handle open, aborts with
  // a libuv "UV_HANDLE_CLOSING" assertion instead of a clean exit. Convert it
  // into a friendly one-line error and a non-zero exit. MCP errors from a
  // sidecar failures are expected user-facing conditions, not crashes.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  // Set exitCode and let the event loop drain instead of calling
  // process.exit(): a synchronous exit while an MCP streamable-http handle is
  // still tearing down triggers a libuv "UV_HANDLE_CLOSING" assertion on
  // Windows. Command actions close their adapters in a `finally`, so the loop
  // has nothing left to keep it alive and exits cleanly with this code.
  process.exitCode = 1;
}
