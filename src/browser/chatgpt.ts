import { Buffer } from "node:buffer";
import type { Locator, Page } from "playwright";
import {
  ASSISTANT_MESSAGE_SELECTOR,
  EFFORT_PICKER_SELECTORS,
  MODEL_PICKER_SELECTORS,
  PICKER_OPTION_SELECTOR,
  PROMPT_SELECTORS,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTORS,
  extractConversationId,
  isValidConversationId,
  normalizeText,
  truncateUtf8,
  uniqueOptions,
} from "./selectors.js";
import { CHATGPT_ORIGIN, type AppConfig } from "../config.js";
import { BrowserRuntime } from "./runtime.js";

export type ChatGptErrorCode =
  | "AUTH_REQUIRED"
  | "UI_CHANGED"
  | "MODEL_UNAVAILABLE"
  | "EFFORT_UNAVAILABLE"
  | "PROMPT_TOO_LARGE"
  | "TIMEOUT";

export class ChatGptWebError extends Error {
  constructor(
    public readonly code: ChatGptErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ChatGptWebError";
  }
}

export interface PickerInfo {
  found: boolean;
  current: string | null;
  options: string[];
}

export interface ChatGptCapabilities {
  modelPicker: PickerInfo;
  effortPicker: PickerInfo;
  flattenedPicker: boolean;
}

export interface ChatRequest {
  prompt: string;
  conversationId?: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
}

export interface ChatResponse {
  conversationId: string | null;
  response: string;
  responseBytes: number;
  truncated: boolean;
  requestedModel: string | null;
  requestedEffort: string | null;
}

function preserveMessageText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

async function firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function waitForFirstVisible(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const locator = await firstVisible(page, selectors);
    if (locator) return locator;
    await page.waitForTimeout(200);
  }
  return null;
}

async function isLoginWall(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (url.includes("/auth/login") || url.includes("/auth/signup")) return true;

  const login = page.getByRole("button", { name: /log in|login|로그인/i }).first();
  return login.isVisible().catch(() => false);
}

async function pickerInfo(
  page: Page,
  selectors: readonly string[]
): Promise<PickerInfo> {
  const button = await firstVisible(page, selectors);
  if (!button) return { found: false, current: null, options: [] };

  const current = normalizeText(await button.innerText().catch(() => ""));
  await button.click();

  try {
    await page.waitForTimeout(150);
    const values = await page.locator(PICKER_OPTION_SELECTOR).allInnerTexts();
    return {
      found: true,
      current: current || null,
      options: uniqueOptions(values),
    };
  } finally {
    await page.keyboard.press("Escape").catch(() => undefined);
  }
}

async function selectExact(
  page: Page,
  selectors: readonly string[],
  label: string,
  code: "MODEL_UNAVAILABLE" | "EFFORT_UNAVAILABLE"
): Promise<void> {
  const button = await firstVisible(page, selectors);
  if (!button) {
    throw new ChatGptWebError(
      "UI_CHANGED",
      "Could not find the ChatGPT picker required to select \"" + label + "\"."
    );
  }

  await button.click();
  await page.waitForTimeout(150);

  try {
    const options = page.locator(PICKER_OPTION_SELECTOR);
    const count = await options.count();
    const available: string[] = [];
    const expected = normalizeText(label);

    for (let index = 0; index < count; index++) {
      const option = options.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      const text = normalizeText(await option.innerText().catch(() => ""));
      if (!text) continue;
      available.push(text);
      if (text === expected) {
        await option.click();
        await page.waitForTimeout(150);
        return;
      }
    }

    throw new ChatGptWebError(
      code,
      "Requested option \"" +
        label +
        "\" is unavailable. Visible options: " +
        (uniqueOptions(available).join(", ") || "(none)")
    );
  } finally {
    await page.keyboard.press("Escape").catch(() => undefined);
  }
}

export class ChatGptWebClient {
  constructor(
    private readonly runtime: BrowserRuntime,
    private readonly config: AppConfig
  ) {}

  private async navigate(page: Page, conversationId?: string): Promise<void> {
    if (conversationId !== undefined) {
      if (!isValidConversationId(conversationId)) {
        throw new Error("Invalid ChatGPT conversation id.");
      }
      await page.goto(CHATGPT_ORIGIN + "/c/" + conversationId, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      return;
    }

    await page.goto(CHATGPT_ORIGIN, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  }

  private async requireComposer(page: Page): Promise<Locator> {
    const composer = await waitForFirstVisible(page, PROMPT_SELECTORS, 15_000);
    if (composer) return composer;

    if (await isLoginWall(page)) {
      throw new ChatGptWebError(
        "AUTH_REQUIRED",
        "ChatGPT authentication is required. Run cgw login in an interactive session."
      );
    }

    throw new ChatGptWebError(
      "UI_CHANGED",
      "Could not find the ChatGPT prompt composer. The web UI may have changed."
    );
  }

  async status(): Promise<{
    authenticated: boolean;
    uiReady: boolean;
    conversationId: string | null;
    headless: boolean;
  }> {
    const page = await this.runtime.page();
    await this.navigate(page);

    const composer = await waitForFirstVisible(page, PROMPT_SELECTORS, 10_000);
    const authenticated = Boolean(composer);
    return {
      authenticated,
      uiReady: authenticated,
      conversationId: extractConversationId(page.url()),
      headless: this.runtime.headless,
    };
  }

  async capabilities(): Promise<ChatGptCapabilities> {
    const page = await this.runtime.page();
    await this.navigate(page);
    await this.requireComposer(page);

    const modelPicker = await pickerInfo(page, MODEL_PICKER_SELECTORS);
    const effortPicker = await pickerInfo(page, EFFORT_PICKER_SELECTORS);

    return {
      modelPicker,
      effortPicker,
      flattenedPicker: modelPicker.found && !effortPicker.found,
    };
  }

  private async applySelections(page: Page, model?: string, effort?: string): Promise<void> {
    if (model) {
      await selectExact(page, MODEL_PICKER_SELECTORS, model, "MODEL_UNAVAILABLE");
    }
    if (effort) {
      const effortButton = await firstVisible(page, EFFORT_PICKER_SELECTORS);
      if (effortButton) {
        await selectExact(page, EFFORT_PICKER_SELECTORS, effort, "EFFORT_UNAVAILABLE");
      } else {
        await selectExact(page, MODEL_PICKER_SELECTORS, effort, "EFFORT_UNAVAILABLE");
      }
    }
  }

  private async generationActive(page: Page): Promise<boolean> {
    return Boolean(await firstVisible(page, STOP_BUTTON_SELECTORS));
  }

  private async waitForAssistant(
    page: Page,
    previousCount: number,
    timeoutMs: number
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastText = "";
    let stablePolls = 0;

    while (Date.now() < deadline) {
      const messages = page.locator(ASSISTANT_MESSAGE_SELECTOR);
      const count = await messages.count();

      if (count > previousCount) {
        const text = preserveMessageText(await messages.last().innerText().catch(() => ""));
        if (text && text === lastText) stablePolls++;
        else stablePolls = 0;
        lastText = text;

        if (text && stablePolls >= 2 && !(await this.generationActive(page))) {
          return text;
        }
      }

      if (await isLoginWall(page)) {
        throw new ChatGptWebError("AUTH_REQUIRED", "ChatGPT session expired during generation.");
      }

      await page.waitForTimeout(500);
    }

    throw new ChatGptWebError(
      "TIMEOUT",
      "ChatGPT did not finish within " + timeoutMs + " ms."
    );
  }

  async chat(input: ChatRequest): Promise<ChatResponse> {
    const promptBytes = Buffer.byteLength(input.prompt, "utf8");
    if (promptBytes === 0) throw new Error("Prompt must not be empty.");
    if (promptBytes > this.config.maxPromptBytes) {
      throw new ChatGptWebError(
        "PROMPT_TOO_LARGE",
        "Prompt is " +
          promptBytes +
          " UTF-8 bytes; limit is " +
          this.config.maxPromptBytes +
          "."
      );
    }

    const page = await this.runtime.page();
    await this.navigate(page, input.conversationId);
    const composer = await this.requireComposer(page);
    await this.applySelections(page, input.model, input.effort);

    const previousCount = await page.locator(ASSISTANT_MESSAGE_SELECTOR).count();

    await composer.fill(input.prompt);
    await page.waitForTimeout(100);

    const send = await firstVisible(page, SEND_BUTTON_SELECTORS);
    if (send && (await send.isEnabled().catch(() => false))) {
      await send.click();
    } else {
      await composer.press("Enter");
    }

    const response = await this.waitForAssistant(
      page,
      previousCount,
      input.timeoutMs ?? this.config.timeoutMs
    );

    const bounded = truncateUtf8(response, this.config.maxResponseBytes);
    return {
      conversationId: extractConversationId(page.url()),
      response: bounded.text,
      responseBytes: bounded.bytes,
      truncated: bounded.truncated,
      requestedModel: input.model ?? null,
      requestedEffort: input.effort ?? null,
    };
  }
}
