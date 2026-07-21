import { describe, it, expect } from "vitest";
import { chunkDocument } from "./chunk.js";

describe("chunkDocument", () => {
  it("splits by markdown headings", () => {
    const content = "# Intro\nhello\n\n## Setup\nsteps here\n\n## Usage\nhow to use";
    const chunks = chunkDocument("guide.md", content);
    expect(chunks.map((c) => c.heading)).toEqual(["Intro", "Setup", "Usage"]);
    expect(chunks.every((c) => c.id.startsWith("guide.md#"))).toBe(true);
  });

  it("keeps content before the first heading as its own chunk", () => {
    const content = "some preamble text\n\n# Section\nbody";
    const chunks = chunkDocument("doc.md", content);
    expect(chunks[0].heading).toBe("");
    expect(chunks[0].content).toContain("preamble");
  });

  it("treats headingless content as a single chunk when short", () => {
    const chunks = chunkDocument("plain.txt", "just plain text, no headings");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("");
  });

  it("hard-wraps a section longer than the max chunk size with overlap", () => {
    const long = "word ".repeat(500); // ~2500 chars, no headings
    const chunks = chunkDocument("long.md", long);
    expect(chunks.length).toBeGreaterThan(1);
    // consecutive chunks overlap: end of chunk[0] reappears near start of chunk[1]
    const tailOfFirst = chunks[0].content.slice(-50);
    expect(chunks[1].content).toContain(tailOfFirst.trim().split(" ").slice(-3).join(" "));
  });

  it("assigns increasing offsets", () => {
    const content = "# A\naaa\n\n# B\nbbb";
    const chunks = chunkDocument("doc.md", content);
    expect(chunks[1].offset).toBeGreaterThan(chunks[0].offset);
  });
});
