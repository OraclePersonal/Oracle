import { describe, expect, test } from "vitest";
import type { ContextFile } from "../types.js";
import { scanFilesForSecrets } from "./secrets.js";

function file(content: string): ContextFile {
  return { path: "config.txt", content, sizeBytes: Buffer.byteLength(content) };
}

describe("scanFilesForSecrets", () => {
  test.each([
    ["private-key", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"],
    ["openai-api-key", "sk-proj-abcdefghijklmnopqrstuvwxyz123456"],
    ["github-token", "ghp_abcdefghijklmnopqrstuvwxyz1234567890"],
    ["sensitive-assignment", "database_password = super-secret-value"]
  ])("detects %s", (detector, content) => {
    expect(scanFilesForSecrets([file(content)])).toEqual([
      { path: "config.txt", line: 1, detector }
    ]);
  });

  test.each([
    "api_key = your-api-key-here",
    "password = <password>",
    "token = process.env.API_TOKEN",
    "client_secret = ${CLIENT_SECRET}",
    "const token = undefined"
  ])("allows placeholder value %s", (content) => {
    expect(scanFilesForSecrets([file(content)])).toEqual([]);
  });

  test("does not include secret values in findings", () => {
    const secret = "extremely-sensitive-value";
    expect(JSON.stringify(scanFilesForSecrets([file(`password=${secret}`)]))).not.toContain(
      secret
    );
  });
});
