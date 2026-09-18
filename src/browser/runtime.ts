import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "../config.js";
import { ProfileLock } from "./profile-lock.js";

export type BrowserRuntimeErrorCode = "PROFILE_BUSY" | "BROWSER_NOT_INSTALLED";

export class BrowserRuntimeError extends Error {
  constructor(
    public readonly code: BrowserRuntimeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BrowserRuntimeError";
  }
}

export interface BrowserLaunchCandidate {
  label: string;
  channel?: string;
  executablePath?: string;
}

function existing(
  value: string | undefined,
  exists: (candidate: string) => boolean
): string | null {
  if (!value) return null;
  return exists(value) ? value : null;
}

export function browserLaunchCandidates(
  config: Pick<AppConfig, "browserChannel" | "browserExecutable">,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exists?: (candidate: string) => boolean;
  } = {}
): BrowserLaunchCandidate[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;

  if (config.browserExecutable) {
    return [
      {
        label: "configured browser executable",
        executablePath: config.browserExecutable,
      },
    ];
  }
  if (config.browserChannel) {
    return [{ label: "configured browser channel", channel: config.browserChannel }];
  }

  const result: BrowserLaunchCandidate[] = [];
  const addPath = (label: string, value: string | undefined) => {
    const found = existing(value, exists);
    if (found && !result.some((item) => item.executablePath === found)) {
      result.push({ label, executablePath: found });
    }
  };

  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
    const programFilesX86 = env["ProgramFiles(x86)"] ?? env.PROGRAMFILES_X86;
    const localAppData = env.LOCALAPPDATA;

    addPath(
      "Microsoft Edge",
      programFilesX86
        ? path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")
        : undefined
    );
    addPath(
      "Microsoft Edge",
      programFiles
        ? path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")
        : undefined
    );
    addPath(
      "Google Chrome",
      programFiles
        ? path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe")
        : undefined
    );
    addPath(
      "Google Chrome",
      programFilesX86
        ? path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
        : undefined
    );
    addPath(
      "Google Chrome",
      localAppData
        ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
        : undefined
    );

    result.push(
      { label: "Microsoft Edge channel", channel: "msedge" },
      { label: "Google Chrome channel", channel: "chrome" }
    );
  } else if (platform === "linux") {
    for (const [label, candidate] of [
      ["Google Chrome", "/usr/bin/google-chrome"],
      ["Google Chrome", "/usr/bin/google-chrome-stable"],
      ["Google Chrome", "/opt/google/chrome/chrome"],
      ["Chromium", "/usr/bin/chromium"],
      ["Chromium", "/usr/bin/chromium-browser"],
      ["Chromium", "/snap/bin/chromium"],
      ["Microsoft Edge", "/usr/bin/microsoft-edge"],
      ["Microsoft Edge", "/usr/bin/microsoft-edge-stable"],
    ] as const) {
      addPath(label, candidate);
    }
    result.push(
      { label: "Google Chrome channel", channel: "chrome" },
      { label: "Microsoft Edge channel", channel: "msedge" }
    );
  } else if (platform === "darwin") {
    result.push(
      { label: "Google Chrome channel", channel: "chrome" },
      { label: "Microsoft Edge channel", channel: "msedge" }
    );
  }

  // Last resort for contributors/users who already have Playwright Chromium.
  result.push({ label: "Playwright Chromium" });
  return result;
}

function isMissingBrowserError(message: string): boolean {
  return /executable.*doesn.?t exist|browser.*not found|distribution.*not found|playwright.*install|could not find.*(?:chrome|edge|chromium)/i.test(
    message
  );
}

function isProfileBusyError(message: string): boolean {
  return /already in use|profile.*use/i.test(message);
}

export class BrowserRuntime {
  private context: BrowserContext | null = null;
  private lock: ProfileLock | null = null;

  constructor(private readonly config: AppConfig) {}

  get headless(): boolean {
    return this.config.headless;
  }

  async start(): Promise<BrowserContext> {
    if (this.context) return this.context;

    try {
      this.lock = ProfileLock.acquire(this.config.profileDir);

      const attempted: string[] = [];
      for (const candidate of browserLaunchCandidates(this.config)) {
        attempted.push(candidate.label);
        try {
          this.context = await chromium.launchPersistentContext(
            this.config.profileDir,
            {
              headless: this.config.headless,
              acceptDownloads: true,
              viewport: { width: 1440, height: 1000 },
              args: ["--disable-dev-shm-usage"],
              ...(candidate.channel ? { channel: candidate.channel } : {}),
              ...(candidate.executablePath
                ? { executablePath: candidate.executablePath }
                : {}),
            }
          );
          this.context.setDefaultTimeout(15_000);
          return this.context;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (isProfileBusyError(message)) {
            throw new BrowserRuntimeError("PROFILE_BUSY", message);
          }
          if (isMissingBrowserError(message)) continue;
          throw error;
        }
      }

      throw new BrowserRuntimeError(
        "BROWSER_NOT_INSTALLED",
        "No supported browser was found. CGW tried: " +
          attempted.join(", ") +
          ". Install Microsoft Edge/Google Chrome on Windows or Chrome/Chromium on Linux. " +
          "Advanced fallback: npx playwright install chromium. " +
          "You can also set CGW_BROWSER_CHANNEL or CGW_BROWSER_EXECUTABLE."
      );
    } catch (error) {
      this.lock?.release();
      this.lock = null;
      if (error instanceof BrowserRuntimeError) throw error;

      const message = error instanceof Error ? error.message : String(error);
      if (isProfileBusyError(message)) {
        throw new BrowserRuntimeError("PROFILE_BUSY", message);
      }
      if (isMissingBrowserError(message)) {
        throw new BrowserRuntimeError(
          "BROWSER_NOT_INSTALLED",
          "No supported Chrome/Edge/Chromium browser was found."
        );
      }
      throw error;
    }
  }

  async newPage(): Promise<Page> {
    const context = await this.start();
    return context.newPage();
  }

  async page(): Promise<Page> {
    const context = await this.start();
    const pages = context.pages();
    const chatPage = pages.find((page) => {
      try {
        const host = new URL(page.url()).hostname;
        return host === "chatgpt.com" || host === "www.chatgpt.com";
      } catch {
        return false;
      }
    });
    if (chatPage) return chatPage;
    if (pages[0]) return pages[0];
    return context.newPage();
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    try {
      if (context) await context.close();
    } finally {
      this.lock?.release();
      this.lock = null;
    }
  }
}
