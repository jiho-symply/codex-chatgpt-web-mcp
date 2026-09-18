import { describe, expect, it } from "vitest";
import { browserLaunchCandidates } from "../src/browser/runtime.js";

describe("browser launch candidates", () => {
  it("prefers installed Edge/Chrome on Windows", () => {
    const found = new Set([
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]);
    const candidates = browserLaunchCandidates(
      { browserChannel: undefined, browserExecutable: undefined },
      {
        platform: "win32",
        env: {
          ProgramFiles: "C:\\Program Files",
          "ProgramFiles(x86)": "C:\\Program Files (x86)",
          LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
        },
        exists: (value) => found.has(value),
      }
    );

    expect(candidates[0]).toEqual({
      label: "Microsoft Edge",
      executablePath:
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    });
    expect(candidates).toContainEqual({
      label: "Microsoft Edge channel",
      channel: "msedge",
    });
    expect(candidates.at(-1)).toEqual({ label: "Playwright Chromium" });
  });

  it("finds system Chromium on Linux before bundled Playwright Chromium", () => {
    const candidates = browserLaunchCandidates(
      { browserChannel: undefined, browserExecutable: undefined },
      {
        platform: "linux",
        env: {},
        exists: (value) => value === "/usr/bin/chromium",
      }
    );

    expect(candidates[0]).toEqual({
      label: "Chromium",
      executablePath: "/usr/bin/chromium",
    });
    expect(candidates.at(-1)).toEqual({ label: "Playwright Chromium" });
  });

  it("respects an explicit executable override without fallback candidates", () => {
    expect(
      browserLaunchCandidates({
        browserChannel: undefined,
        browserExecutable: "/opt/custom/chrome",
      })
    ).toEqual([
      {
        label: "configured browser executable",
        executablePath: "/opt/custom/chrome",
      },
    ]);
  });

  it("respects an explicit Playwright channel override", () => {
    expect(
      browserLaunchCandidates({
        browserChannel: "chrome",
        browserExecutable: undefined,
      })
    ).toEqual([{ label: "configured browser channel", channel: "chrome" }]);
  });
});
