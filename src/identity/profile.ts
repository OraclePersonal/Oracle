import fs from "node:fs/promises";
import path from "node:path";
import type { Identity, Persona } from "./types.js";
import { DEFAULT_PERSONA } from "./types.js";

export class ProfileStore {
  constructor(private readonly rootDir: string) {}

  private identityPath(): string {
    return path.join(this.rootDir, "identity.json");
  }

  private personaPath(): string {
    return path.join(this.rootDir, "persona.json");
  }

  async getIdentity(): Promise<Identity | null> {
    try {
      return JSON.parse(await fs.readFile(this.identityPath(), "utf8"));
    } catch {
      return null;
    }
  }

  async saveIdentity(identity: Identity): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.identityPath(), JSON.stringify(identity, null, 2), "utf8");
  }

  async getPersona(): Promise<Persona> {
    try {
      return { ...DEFAULT_PERSONA, ...JSON.parse(await fs.readFile(this.personaPath(), "utf8")) };
    } catch {
      return { ...DEFAULT_PERSONA };
    }
  }

  async savePersona(persona: Persona): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.personaPath(), JSON.stringify(persona, null, 2), "utf8");
  }

  // Build the system prompt prefix that makes Oracle "know who you are"
  async buildPersonalContext(): Promise<string> {
    const [identity, persona] = await Promise.all([this.getIdentity(), this.getPersona()]);
    const parts: string[] = [];

    if (persona) {
      parts.push(`You are ${persona.name}. ${persona.greeting ?? ""}`);
      if (persona.tone) parts.push(`Tone: ${persona.tone}.`);
      if (persona.style) parts.push(`Style: ${persona.style}`);
      if (persona.systemPrompt) parts.push(persona.systemPrompt);
    }

    if (identity) {
      parts.push("");
      parts.push(`You are speaking to ${identity.name}.`);
      if (identity.title) parts.push(`Title: ${identity.title}`);
      if (identity.role) parts.push(`Role: ${identity.role}`);
      if (identity.description) parts.push(`About them: ${identity.description}`);
      if (identity.preferences?.length) parts.push(`Preferences: ${identity.preferences.join(", ")}`);
      if (identity.habits?.length) parts.push(`Habits: ${identity.habits.join(", ")}`);
      if (identity.goals?.length) parts.push(`Goals: ${identity.goals.join(", ")}`);
      if (identity.traits) {
        for (const [key, val] of Object.entries(identity.traits)) {
          parts.push(`${key}: ${val}`);
        }
      }
    }

    return parts.join("\n");
  }
}
