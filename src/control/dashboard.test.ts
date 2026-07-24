import { describe, expect, test } from "vitest";
import { renderControlCenterDashboard } from "./dashboard.js";

describe("Control Center dashboard", () => {
  test("renders a dependency-free blue dashboard with local authenticated API calls", () => {
    const html = renderControlCenterDashboard();
    expect(html).toContain("<title>Oracle Control Center</title>");
    expect(html).toContain("--blue:");
    expect(html).toContain("/v1/control/snapshot");
    expect(html).toContain("authorization: \"Bearer \" + token");
    expect(html).toContain("history.replaceState");
    expect(html).not.toContain("https://cdn.");
  });
});
