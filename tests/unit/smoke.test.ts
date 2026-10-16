import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/index";

describe("package", () => {
  it("exposes its version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
