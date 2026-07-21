import { describe, expect, test } from "vitest";
import { OracleError, serializeOracleError } from "./errors.js";

describe("serializeOracleError", () => {
  test("preserves expected safe errors", () => {
    expect(
      serializeOracleError(new OracleError("ORACLE_NO_FILES", "No files.", "Select files."))
    ).toEqual({ code: "ORACLE_NO_FILES", message: "No files.", suggestion: "Select files." });
  });

  test("hides unexpected error messages", () => {
    expect(serializeOracleError(new Error("password=hunter2"))).not.toEqual(
      expect.objectContaining({ message: expect.stringContaining("hunter2") })
    );
  });
});
