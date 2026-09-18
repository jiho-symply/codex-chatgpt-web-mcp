import { chromium, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "../config.js";
import { ProfileLock } from "./profile-lock.js";

export class BrowserRuntime {
  private context: BrowserContext | null = null;
  private lock: ProfileLock | null = null;

  constructor(private readonly config: AppConfig) {}

  get headless(): boolean {
    return this.config.headless;
  }

  async start(): Promise<BrowserContext> {
    if (this.context) return this.context;

    this.lock = ProfileLock.acquire(this.config.profileDir);
    try {
      const channel = this.config.browserChannel;
      this.context = await chromium.launchPersistentContext(this.config.profileDir, {
        headless: this.config.headless,
        acceptDownloads: false,
        viewport: { width: 1440, height: 1000 },
        args: ["--disable-dev-shm-usage"],
        ...(channel ? { channel } : {}),
      });
      this.context.setDefaultTimeout(15_000);
      return this.context;
    } catch (error) {
      this.lock.release();
      this.lock = null;
      const message = error instanceof Error ? error.message : String(error);
      if (/executable.*doesn.t exist|browser.*not found|playwright.*install/i.test(message)) {
        throw new Error(
          "Playwright Chromium is not installed. Run: npx playwright install chromium " +
            "(or --with-deps chromium on Linux)."
        );
      }
      throw error;
    }
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
