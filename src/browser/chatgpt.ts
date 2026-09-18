import { Buffer } from "node:buffer";
import type { Locator, Page } from "playwright";
import {
  ASSISTANT_MESSAGE_SELECTOR,
  CONTINUE_BUTTON_SELECTORS,
  COPY_BUTTON_SELECTORS,
  EFFORT_PICKER_SELECTORS,
  GLOBAL_ERROR_SELECTOR,
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
  | "CHALLENGE_REQUIRED"
  | "SESSION_LOST"
  | "CONVERSATION_NOT_FOUND"
  | "RATE_LIMITED"
  | "REMOTE_ERROR"
  | "UI_CHANGED"
  | "MODEL_UNAVAILABLE"
  | "EFFORT_UNAVAILABLE"
  | "PROMPT_TOO_LARGE";

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

export interface BrowserDispatchRequest {
  prompt: string;
  conversationId?: string;
  model?: string;
  effort?: string;
}

export interface BrowserTurnDispatch {
  conversationId: string | null;
  baselineAssistantCount: number;
}

export interface BrowserTurnSnapshot {
  conversationId: string | null;
  complete: boolean;
  paused: boolean;
  generating: boolean;
  response: string | null;
  responseBytes: number;
  truncated: boolean;
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

async function challengePresent(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (url.includes("/cdn-cgi/") || url.includes("challenge")) return true;
  const title = (await page.title().catch(() => "")).toLowerCase();
  if (title.includes("just a moment")) return true;
  const visible = await page
    .getByText(/verify you are human|checking your browser|사람인지 확인/i)
    .first()
    .isVisible()
    .catch(() => false);
  return visible;
}

async function throwPageProblem(page: Page): Promise<void> {
  if (await isLoginWall(page)) {
    throw new ChatGptWebError(
      "AUTH_REQUIRED",
      "ChatGPT authentication is required. Run cgw login in an interactive session."
    );
  }
  if (await challengePresent(page)) {
    throw new ChatGptWebError(
      "CHALLENGE_REQUIRED",
      "ChatGPT is showing a browser verification challenge. Complete it manually; this proxy does not bypass challenges."
    );
  }

  const alerts = uniqueOptions(
    await page.locator(GLOBAL_ERROR_SELECTOR).allInnerTexts().catch(() => [])
  );
  const joined = alerts.join(" | ");
  if (/rate limit|too many requests|usage limit|try again later|잠시 후 다시/i.test(joined)) {
    throw new ChatGptWebError("RATE_LIMITED", joined || "ChatGPT rate limit reached.");
  }
  if (/something went wrong|network error|오류가 발생|문제가 발생/i.test(joined)) {
    throw new ChatGptWebError("REMOTE_ERROR", joined);
  }
}

async function pickerInfo(page: Page, selectors: readonly string[]): Promise<PickerInfo> {
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
      'Could not find the ChatGPT picker required to select "' + label + '".'
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
      'Requested option "' +
        label +
        '" is unavailable. Visible options: ' +
        (uniqueOptions(available).join(", ") || "(none)")
    );
  } finally {
    await page.keyboard.press("Escape").catch(() => undefined);
  }
}

async function messageHasCopyButton(message: Locator): Promise<boolean> {
  for (const selector of COPY_BUTTON_SELECTORS) {
    if (await message.locator(selector).first().isVisible().catch(() => false)) return true;
  }
  return false;
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
      const response = await page.goto(CHATGPT_ORIGIN + "/c/" + conversationId, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      if (response && [404, 410].includes(response.status())) {
        throw new ChatGptWebError(
          "CONVERSATION_NOT_FOUND",
          "ChatGPT conversation was not found: " + conversationId
        );
      }
      await page.waitForTimeout(300);
      await throwPageProblem(page);
      const actual = extractConversationId(page.url());
      if (actual !== conversationId) {
        throw new ChatGptWebError(
          actual ? "SESSION_LOST" : "CONVERSATION_NOT_FOUND",
          actual
            ? "ChatGPT opened a different conversation than requested."
            : "ChatGPT did not remain on the requested conversation."
        );
      }
      return;
    }

    await page.goto(CHATGPT_ORIGIN, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await throwPageProblem(page);
  }

  private async ensureConversation(page: Page, conversationId: string | null): Promise<void> {
    if (!conversationId) {
      const deadline = Date.now() + 5_000;
      let current = extractConversationId(page.url());
      while (!current && Date.now() < deadline) {
        await throwPageProblem(page);
        await page.waitForTimeout(250);
        current = extractConversationId(page.url());
      }
      if (!current) {
        throw new ChatGptWebError(
          "SESSION_LOST",
          "This turn has no recoverable ChatGPT conversation id. Refusing to guess from another page."
        );
      }
      return;
    }
    if (extractConversationId(page.url()) === conversationId) return;
    await this.navigate(page, conversationId);
  }

  private async requireComposer(page: Page): Promise<Locator> {
    const composer = await waitForFirstVisible(page, PROMPT_SELECTORS, 15_000);
    if (composer) return composer;
    await throwPageProblem(page);
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
    if (model) await selectExact(page, MODEL_PICKER_SELECTORS, model, "MODEL_UNAVAILABLE");
    if (effort) {
      const effortButton = await firstVisible(page, EFFORT_PICKER_SELECTORS);
      if (effortButton) {
        await selectExact(page, EFFORT_PICKER_SELECTORS, effort, "EFFORT_UNAVAILABLE");
      } else {
        await selectExact(page, MODEL_PICKER_SELECTORS, effort, "EFFORT_UNAVAILABLE");
      }
    }
  }

  async dispatch(input: BrowserDispatchRequest): Promise<BrowserTurnDispatch> {
    const promptBytes = Buffer.byteLength(input.prompt, "utf8");
    if (promptBytes === 0) throw new Error("Prompt must not be empty.");
    if (promptBytes > this.config.maxPromptBytes) {
      throw new ChatGptWebError(
        "PROMPT_TOO_LARGE",
        "Prompt is " + promptBytes + " UTF-8 bytes; limit is " + this.config.maxPromptBytes + "."
      );
    }

    const page = await this.runtime.page();
    await this.navigate(page, input.conversationId);
    const composer = await this.requireComposer(page);
    await this.applySelections(page, input.model, input.effort);

    const baselineAssistantCount = await page.locator(ASSISTANT_MESSAGE_SELECTOR).count();
    await composer.fill(input.prompt);
    await page.waitForTimeout(100);

    const send = await firstVisible(page, SEND_BUTTON_SELECTORS);
    if (send && (await send.isEnabled().catch(() => false))) await send.click();
    else await composer.press("Enter");

    const deadline = Date.now() + 10_000;
    let conversationId = input.conversationId ?? extractConversationId(page.url());
    while (!conversationId && Date.now() < deadline) {
      await throwPageProblem(page);
      await page.waitForTimeout(250);
      conversationId = extractConversationId(page.url());
    }

    return { conversationId, baselineAssistantCount };
  }

  async inspectTurn(input: {
    conversationId: string | null;
    baselineAssistantCount: number;
    timeoutMs: number;
  }): Promise<BrowserTurnSnapshot> {
    const page = await this.runtime.page();
    await this.ensureConversation(page, input.conversationId);

    const deadline = Date.now() + Math.max(0, input.timeoutMs);
    let lastText = "";
    let stableSince = Date.now();
    let first = true;

    do {
      await throwPageProblem(page);
      const messages = page.locator(ASSISTANT_MESSAGE_SELECTOR);
      const count = await messages.count();
      const stopVisible = Boolean(await firstVisible(page, STOP_BUTTON_SELECTORS));
      const paused = Boolean(await firstVisible(page, CONTINUE_BUTTON_SELECTORS));

      let response: string | null = null;
      let copyVisible = false;
      if (count > input.baselineAssistantCount) {
        const message = messages.last();
        response = preserveMessageText(await message.innerText().catch(() => ""));
        copyVisible = await messageHasCopyButton(message);
      }

      if (response !== lastText) {
        lastText = response ?? "";
        stableSince = Date.now();
      }

      const stableLongEnough = Boolean(response) && Date.now() - stableSince >= this.config.stableMs;
      const complete =
        Boolean(response) && !stopVisible && !paused && (copyVisible || stableLongEnough);

      if (complete || paused || input.timeoutMs === 0) {
        const bounded = truncateUtf8(response ?? "", this.config.maxResponseBytes);
        return {
          conversationId: extractConversationId(page.url()) ?? input.conversationId,
          complete,
          paused,
          generating: !complete && !paused,
          response: response === null ? null : bounded.text,
          responseBytes: bounded.bytes,
          truncated: bounded.truncated,
        };
      }

      first = false;
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(500);
    } while (first || Date.now() <= deadline);

    const messages = page.locator(ASSISTANT_MESSAGE_SELECTOR);
    const count = await messages.count();
    const response =
      count > input.baselineAssistantCount
        ? preserveMessageText(await messages.last().innerText().catch(() => ""))
        : null;
    const bounded = truncateUtf8(response ?? "", this.config.maxResponseBytes);
    return {
      conversationId: extractConversationId(page.url()) ?? input.conversationId,
      complete: false,
      paused: Boolean(await firstVisible(page, CONTINUE_BUTTON_SELECTORS)),
      generating: true,
      response: response === null ? null : bounded.text,
      responseBytes: bounded.bytes,
      truncated: bounded.truncated,
    };
  }

  async stopTurn(input: {
    conversationId: string | null;
    baselineAssistantCount: number;
  }): Promise<BrowserTurnSnapshot> {
    const page = await this.runtime.page();
    await this.ensureConversation(page, input.conversationId);
    const stop = await firstVisible(page, STOP_BUTTON_SELECTORS);
    if (stop) {
      await stop.click();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await firstVisible(page, STOP_BUTTON_SELECTORS))) {
        await page.waitForTimeout(200);
      }
    }
    return this.inspectTurn({
      conversationId: extractConversationId(page.url()) ?? input.conversationId,
      baselineAssistantCount: input.baselineAssistantCount,
      timeoutMs: 0,
    });
  }
}
