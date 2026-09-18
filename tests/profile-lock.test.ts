import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileLock } from "../src/browser/profile-lock.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-lock-"));
  dirs.push(dir);
  return dir;
}

describe("ProfileLock", () => {
  it("prevents concurrent use and releases cleanly", () => {
    const dir = tmp();
    const first = ProfileLock.acquire(dir);
    expect(() => ProfileLock.acquire(dir)).toThrow(/already in use/i);
    first.release();

    const second = ProfileLock.acquire(dir);
    second.release();
  });

  it("recovers a clearly stale lock", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, ".cgw-profile.lock"),
      JSON.stringify({ pid: 99999999, nonce: "stale", createdAt: new Date().toISOString() })
    );
    const lock = ProfileLock.acquire(dir);
    lock.release();
  });
});
