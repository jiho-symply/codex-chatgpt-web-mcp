import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { EVALUATE_NAME_SHIM } from "../src/browser/eval-shim.js";

describe("page evaluation name shim", () => {
  it("provides the helper emitted by tsx/esbuild without changing function behavior", () => {
    const context = vm.createContext({});
    vm.runInContext(EVALUATE_NAME_SHIM, context);

    const result = vm.runInContext(
      '__name((value) => { const plusOne = __name((x) => x + 1, "plusOne"); return plusOne(value); }, "outer")(41)',
      context
    );

    expect(result).toBe(42);
  });

  it("does not overwrite an existing page helper", () => {
    const context = vm.createContext({
      __name: (target: unknown) => ({ wrapped: target }),
    });
    const before = context.__name;
    vm.runInContext(EVALUATE_NAME_SHIM, context);
    expect(context.__name).toBe(before);
  });
});
