import { execFileSync } from "node:child_process";
import type { PR, PRFile, Issue, Comment, Branch, SearchResult } from "./types.js";

// ponytail: wraps gh CLI — no octokit dep, pipes the tool that's already on the machine.

interface GhOptions {
  repo?: string;
  json?: string[];
  jq?: string;
  template?: string;
  fields?: string[];
}

export class GitHubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stderr: string
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

function buildArgs(command: string[], opts: GhOptions): string[] {
  const args = [...command];
  if (opts.repo) args.push("-R", opts.repo);
  if (opts.json) args.push("--json", opts.json.join(","));
  if (opts.jq) args.push("--jq", opts.jq);
  if (opts.template) args.push("--template", opts.template);
  if (opts.fields) args.push("--fields", opts.fields.join(","));
  return args;
}

function runGh(args: string[], input?: string): string {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      input,
    });
  } catch (e: any) {
    if (e.code === "ENOENT") {
      throw new GitHubError(
        "GH_NOT_FOUND",
        "gh CLI is not installed. Install it from https://cli.github.com/",
        ""
      );
    }
    const stderr = (e.stderr || e.message || "").trim();
    throw new GitHubError("GH_ERROR", stderr || `gh command failed: ${args.join(" ")}`, stderr);
  }
}

function parsePR(raw: any): PR {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state?.toLowerCase() === "merged" ? "merged" : raw.state?.toLowerCase() === "open" ? "open" : "closed",
    body: raw.body ?? "",
    author: raw.author?.login ?? raw.author?.name ?? "",
    baseRef: raw.baseRefName ?? "",
    headRef: raw.headRefName ?? "",
    headRepo: raw.headRepository ? { owner: raw.headRepository.owner?.login ?? "", repo: raw.headRepository.name ?? "" } : undefined,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergedAt: raw.mergedAt,
    closedAt: raw.closedAt,
    labels: (raw.labels ?? []).map((l: any) => l.name ?? l),
    url: raw.url ?? "",
  };
}

function parseIssue(raw: any): Issue {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state?.toLowerCase() === "open" ? "open" : "closed",
    body: raw.body ?? "",
    author: raw.author?.login ?? raw.author?.name ?? "",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    closedAt: raw.closedAt,
    labels: (raw.labels ?? []).map((l: any) => l.name ?? l),
    url: raw.url ?? "",
  };
}

// ── Public API ──────────────────────────────────────────────────────

/** Infer repo from the local git remote, or use the explicit -R value. */
export function inferRepo(cwd?: string): string | undefined {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      cwd,
    }).trim();
    // handle git@github.com:owner/repo.git and https://github.com/owner/repo
    const m =
      remote.match(/github\.com[:/](.+\/.+?)(?:\.git)?$/) ??
      remote.match(/github\.com\/(.+)$/);
    return m ? m[1].replace(/\.git$/, "") : undefined;
  } catch {
    return undefined;
  }
}

export function checkGh(): { ok: boolean; version?: string; error?: string } {
  try {
    const out = execFileSync("gh", ["--version"], { encoding: "utf8" });
    const version = out.trim().split("\n")[0];
    return { ok: true, version };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export function checkGhAuth(): { ok: boolean; user?: string; error?: string } {
  try {
    const out = execFileSync("gh", ["auth", "status", "--show-token"], {
      encoding: "utf8",
    });
    const m = out.match(/Logged in to github\.com as (\S+)/);
    return { ok: true, user: m?.[1] };
  } catch (e: any) {
    return { ok: false, error: e.stderr?.trim() || e.message };
  }
}

/** Fetch PR details. repo = "owner/repo" */
export function getPR(number: number, repo?: string): PR {
  const out = runGh(buildArgs(["pr", "view", String(number)], {
    repo,
    json: [
      "number", "title", "state", "body", "url",
      "author", "baseRefName", "headRefName", "headRepository",
      "createdAt", "updatedAt", "mergedAt", "closedAt", "labels",
    ],
  }));
  return parsePR(JSON.parse(out));
}

/** List PRs with optional state filter */
export function listPRs(opts: {
  repo?: string;
  state?: "open" | "closed" | "merged" | "all";
  limit?: number;
  base?: string;
  head?: string;
  author?: string;
  labels?: string[];
}): PR[] {
  const args = ["pr", "list"];
  if (opts.state && opts.state !== "all") args.push("--state", opts.state);
  if (opts.base) args.push("--base", opts.base);
  if (opts.head) args.push("--head", opts.head);
  if (opts.author) args.push("--author", opts.author);
  if (opts.labels?.length) args.push("--label", opts.labels.join(","));
  args.push("--limit", String(opts.limit ?? 30));

  const out = runGh(buildArgs(args, {
    repo: opts.repo,
    json: [
      "number", "title", "state", "body", "url",
      "author", "baseRefName", "headRefName", "headRepository",
      "createdAt", "updatedAt", "mergedAt", "labels",
    ],
  }));
  const list = JSON.parse(out);
  return list.map(parsePR);
}

/** Get the full diff for a PR */
export function getPRDiff(number: number, repo?: string): string {
  return runGh(buildArgs(["pr", "diff", String(number)], { repo }));
}

/** Get the list of changed files in a PR */
export function getPRFiles(number: number, repo?: string): PRFile[] {
  const out = runGh(buildArgs(["pr", "view", String(number)], {
    repo,
    json: ["files"],
    jq: '.files[] | [.path, .status, .additions, .deletions] | @tsv',
  }));
  return out.trim().split("\n").filter(Boolean).map((line) => {
    const [path, status, additions, deletions] = line.split("\t");
    return {
      path,
      status: (status ?? "modified") as PRFile["status"],
      additions: Number(additions) || 0,
      deletions: Number(deletions) || 0,
    };
  });
}

/** Submit a PR review (approve/comment/request-changes) */
export function submitPRReview(
  number: number,
  body: string,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  repo?: string
): Comment {
  const flag = event === "APPROVE" ? "--approve" : event === "REQUEST_CHANGES" ? "--request-changes" : "--comment";
  const args = ["pr", "review", String(number), flag];
  if (body && event !== "APPROVE") args.push("--body", body);
  runGh(buildArgs(args, { repo }));
  return { id: 0, body, author: "you", createdAt: new Date().toISOString() };
}

/** Fetch issue details */
export function getIssue(number: number, repo?: string): Issue {
  const out = runGh(buildArgs(["issue", "view", String(number)], {
    repo,
    json: ["number", "title", "state", "body", "url", "author", "createdAt", "updatedAt", "closedAt", "labels"],
  }));
  return parseIssue(JSON.parse(out));
}

/** List issues */
export function listIssues(opts: {
  repo?: string;
  state?: "open" | "closed" | "all";
  limit?: number;
  author?: string;
  labels?: string[];
}): Issue[] {
  const args = ["issue", "list"];
  if (opts.state && opts.state !== "all") args.push("--state", opts.state);
  if (opts.author) args.push("--author", opts.author);
  if (opts.labels?.length) args.push("--label", opts.labels.join(","));
  args.push("--limit", String(opts.limit ?? 30));

  const out = runGh(buildArgs(args, {
    repo: opts.repo,
    json: ["number", "title", "state", "body", "url", "author", "createdAt", "updatedAt", "closedAt", "labels"],
  }));
  return JSON.parse(out).map(parseIssue);
}

/** Comment on an issue or PR */
export function createComment(number: number, body: string, repo?: string): Comment {
  runGh(buildArgs(["issue", "comment", String(number), "--body", body], { repo }));
  return { id: 0, body, author: "you", createdAt: new Date().toISOString() };
}

/** Get file content from a repo at a ref */
export function getContent(path: string, repo?: string, ref?: string): string {
  const args = ["api", `repos/${repo}/contents/${path}`];
  if (ref) args.push("--jq", `.content | @base64d`);
  else args.push("--jq", `.content | @base64d`);
  try {
    return runGh(args);
  } catch (e: any) {
    throw new GitHubError("GH_FILE_NOT_FOUND", `Failed to fetch ${repo}/${path}`, e.stderr || "");
  }
}

/** Raw gh API call */
export function apiRequest<T = unknown>(endpoint: string, method = "GET", body?: unknown): T {
  const args = ["api", endpoint, "--method", method];
  if (body) args.push("--input", "-");
  const out = runGh(args, body ? JSON.stringify(body) : undefined);
  return JSON.parse(out);
}

/** List branches */
export function listBranches(repo?: string): Branch[] {
  const out = runGh(buildArgs(["repo", "view"], { repo, json: ["defaultBranch"] }));
  const { defaultBranch } = JSON.parse(out);
  const branches = runGh(buildArgs(["api", `repos/${repo}/branches`], {}));
  const list: any[] = JSON.parse(branches);
  return list.map((b) => ({
    name: b.name,
    default: b.name === defaultBranch,
  }));
}

/** Search code across repos */
export function searchCode(query: string, limit = 10): SearchResult[] {
  const out = runGh(["api", `search/code?q=${encodeURIComponent(query)}&per_page=${limit}`, "--jq", ".items"]);
  const items: any[] = JSON.parse(out);
  return items.map((item) => ({
    path: item.path,
    repo: item.repository?.full_name ?? "",
    matches: [item.text_matches?.map((m: any) => m.fragment).filter(Boolean).join(" ") ?? ""].filter(Boolean),
  }));
}

/** Infer owner/repo from a PR/issue URL */
export function parseGhUrl(url: string): { owner: string; repo: string; type: "pr" | "issue" | "discussion"; number?: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/);
  if (m) {
    const type = url.includes("/pull/") ? "pr" as const : "issue" as const;
    return { owner: m[1], repo: m[2], type, number: Number(m[3]) };
  }
  return null;
}
