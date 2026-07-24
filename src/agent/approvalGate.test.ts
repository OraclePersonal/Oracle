import { describe, expect, test } from "vitest";
import { classifyToolRisk } from "./approvalGate.js";

describe("classifyToolRisk", () => {
  test.each([
    "git push origin main",
    "git\npush origin main",
    "npm publish",
    "kubectl apply -f deployment.yml",
    "terraform destroy",
    "ssh production",
    "rm old-release.tar"
  ])("classifies high-risk command %s", (command) => {
    expect(classifyToolRisk("bash", { command })).toMatchObject({ risk: "high" });
  });

  test("does not gate a read-only shell inspection in risky mode", () => {
    expect(classifyToolRisk("bash", { command: "git status --short" })).toBeNull();
    expect(classifyToolRisk("read_file", { path: "README.md" })).toBeNull();
  });

  test("classifies trusted external mutation tools by action name", () => {
    expect(classifyToolRisk("release_publish", {})).toMatchObject({ risk: "high" });
    expect(classifyToolRisk("read_repository", {})).toBeNull();
  });
});
