import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/util/serial.js";

describe("SerialQueue", () => {
  it("runs operations in submission order", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];

    const first = queue.run(async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 25));
      events.push("first:end");
      return 1;
    });

    const second = queue.run(async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("continues after a failed operation", async () => {
    const queue = new SerialQueue();
    await expect(
      queue.run(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    await expect(queue.run(async () => 42)).resolves.toBe(42);
  });
});
