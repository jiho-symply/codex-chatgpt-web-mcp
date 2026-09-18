import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir } from "../config.js";

interface LockRecord {
  pid: number;
  nonce: string;
  createdAt: string;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export class ProfileLock {
  private released = false;

  private constructor(
    private readonly file: string,
    private readonly nonce: string
  ) {}

  static acquire(profileDir: string): ProfileLock {
    ensurePrivateDir(profileDir);
    const file = path.join(profileDir, ".cgw-profile.lock");

    for (let attempt = 0; attempt < 2; attempt++) {
      const nonce = randomUUID();
      const record: LockRecord = {
        pid: process.pid,
        nonce,
        createdAt: new Date().toISOString(),
      };

      try {
        fs.writeFileSync(file, JSON.stringify(record), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        return new ProfileLock(file, nonce);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;

        let stale = true;
        try {
          const current = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockRecord>;
          stale = !processAlive(current.pid ?? -1);
        } catch {
          stale = true;
        }

        if (!stale) {
          throw new Error(
            "The ChatGPT browser profile is already in use by another process. " +
              "Stop the other cgw/MCP process before continuing."
          );
        }

        fs.rmSync(file, { force: true });
      }
    }

    throw new Error("Could not acquire browser profile lock.");
  }

  release(): void {
    if (this.released) return;
    this.released = true;

    try {
      const current = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<LockRecord>;
      if (current.nonce === this.nonce) fs.rmSync(this.file, { force: true });
    } catch {
      // Best effort during shutdown.
    }
  }
}
