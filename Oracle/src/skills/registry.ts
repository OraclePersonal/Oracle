import fs from "node:fs/promises";
import path from "node:path";
import type { Skill } from "./types.js";

const BUILT_IN: Skill[] = [
  {
    name: "review",
    description: "Review for concrete correctness, maintainability, and verification gaps.",
    systemPrompt: "Review for concrete correctness, maintainability, and verification gaps."
  },
  {
    name: "debug",
    description: "Find the root cause, distinguish evidence from hypotheses, and propose the smallest verified fix.",
    systemPrompt: "Find the root cause, distinguish evidence from hypotheses, and propose the smallest verified fix."
  },
  {
    name: "architecture",
    description: "Assess boundaries, dependencies, data flow, and trade-offs without inventing requirements.",
    systemPrompt: "Assess boundaries, dependencies, data flow, and trade-offs without inventing requirements."
  },
  {
    name: "tests",
    description: "Identify missing behavioral coverage, edge cases, and the highest-value tests.",
    systemPrompt: "Identify missing behavioral coverage, edge cases, and the highest-value tests."
  },
  {
    name: "security",
    description: "Audit trust boundaries, data exposure, injection risks, credential handling, and safe mitigations.",
    systemPrompt: "Audit trust boundaries, data exposure, injection risks, credential handling, and safe mitigations."
  },
  {
    name: "github-pr-review",
    description: "Review a GitHub pull request for correctness, edge cases, security, and maintainability.",
    systemPrompt: "You are reviewing a GitHub pull request. Analyze the diff and changed files thoroughly. Categorize every finding by severity (critical/major/minor/nit). Critical issues block merge. For each finding, cite the exact file and line number from the diff. Distinguish between issues in the PR's own code vs pre-existing issues in the surrounding code. End with a clear verdict: approve, request changes, or comment."
  }
];

// ponytail: skills loaded from user dir + project dir; built-in as fallback
export class SkillRegistry {
  private skills = new Map<string, Skill>();

  constructor(
    private readonly userDir: string,
    private readonly projectDir?: string
  ) {}

  async load(): Promise<void> {
    this.skills.clear();
    for (const skill of BUILT_IN) this.skills.set(skill.name, skill);
    const dirs = [this.projectDir, path.join(this.userDir, "skills")].filter(
      (d): d is string => !!d
    );
    for (const dir of dirs) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          const skill = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as Skill;
          if (skill.name) this.skills.set(skill.name, skill);
        }
      } catch {
        // dir doesn't exist yet
      }
    }
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  names(): string[] {
    return [...this.skills.keys()];
  }

  async install(filePath: string): Promise<string> {
    const raw = await fs.readFile(filePath, "utf8");
    const skill = JSON.parse(raw) as Skill;
    if (!skill.name) throw new Error("Skill file must have a 'name' field.");
    const destDir = path.join(this.userDir, "skills");
    await fs.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, `${skill.name}.json`);
    await fs.writeFile(dest, JSON.stringify(skill, null, 2), "utf8");
    this.skills.set(skill.name, skill);
    return skill.name;
  }

  compose(name: string, basePrompt: string): string {
    const skill = this.get(name);
    return skill ? `${basePrompt.trim()} ${skill.systemPrompt}` : basePrompt;
  }
}
