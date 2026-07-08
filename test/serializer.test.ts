import { describe, it, expect } from "vitest";
import { stableStringify } from "../src/types.js";

describe("stableStringify", () => {
  it("emits object keys in sorted order regardless of insertion order", () => {
    const a = stableStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = stableStringify({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{\n  "a": 2,\n  "b": 1,\n  "c": {\n    "y": 2,\n    "z": 1\n  }\n}');
  });

  it("preserves array order (order is meaningful)", () => {
    expect(stableStringify([3, 1, 2])).toBe("[\n  3,\n  1,\n  2\n]");
  });

  it("drops undefined for stability and throws on cycles", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{\n  "b": 1\n}');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => stableStringify(cyc)).toThrow(/circular/);
  });
});
