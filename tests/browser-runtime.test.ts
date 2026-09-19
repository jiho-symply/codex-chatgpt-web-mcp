import { describe, expect, it } from "vitest";
import {
  browserLaunchCandidates,
  systemCdpLaunchArgs,
  windowsDefaultBrowserFamilyFromRegistryOutput,
} from "../src/browser/runtime.js";

describe("browser launch candidates", () => {
  it("prefers Chrome when Windows reports Chrome as the default browser", () => {
    const found = new Set([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
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
        windowsDefaultBrowserFamily: () => "chrome",
      }
    );

    expect(candidates[0]).toEqual({
      label: "Google Chrome",
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    });
    expect(candidates.findIndex((item) => item.label === "Microsoft Edge")).toBeGreaterThan(0);
  });

  it("prefers Edge when Windows reports Edge as the default browser", () => {
    const found = new Set([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
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
        windowsDefaultBrowserFamily: () => "edge",
      }
    );

    expect(candidates[0]).toEqual({
      label: "Microsoft Edge",
      executablePath:
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    });
  });

  it("parses Windows default browser ProgId values", () => {
    expect(
      windowsDefaultBrowserFamilyFromRegistryOutput(
        "HKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    ChromeHTML\r\n"
      )
    ).toBe("chrome");
    expect(
      windowsDefaultBrowserFamilyFromRegistryOutput(
        "HKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    MSEdgeHTM\r\n"
      )
    ).toBe("edge");
    expect(
      windowsDefaultBrowserFamilyFromRegistryOutput(
        "HKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    FirefoxURL-123\r\n"
      )
    ).toBeNull();
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
  it("normalizes Windows system-CDP coordinates without WebDriver-style flags", () => {
    const args = systemCdpLaunchArgs("C:\\CGW\\profile", 9333, "win32");
    expect(args).toEqual([
      "--user-data-dir=C:\\CGW\\profile",
      "--remote-debugging-port=9333",
      "--force-device-scale-factor=1",
      "https://chatgpt.com",
    ]);
    expect(
      args.some(
        (arg) =>
          arg === "--headless" ||
          arg === "--enable-automation" ||
          arg === "--no-sandbox"
      )
    ).toBe(false);
    expect(args).not.toContain("--remote-debugging-port=0");
  });

  it("does not force device scale outside Windows", () => {
    const args = systemCdpLaunchArgs("/tmp/cgw-profile", 9333, "linux");
    expect(args).not.toContain("--force-device-scale-factor=1");
  });

  it("rejects port zero for system-CDP", () => {
    expect(() => systemCdpLaunchArgs("C:\\CGW\\profile", 0)).toThrow(/non-zero/i);
  });

});
