import type { Locator, Page } from "playwright";
import {
  CONTINUE_BUTTON_SELECTORS,
  GLOBAL_ERROR_SELECTOR,
  PROMPT_SELECTORS,
  REGENERATE_BUTTON_SELECTORS,
  RETRY_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTORS,
  uniqueOptions,
} from "./selectors.js";

export type ChatGptUiState =
  | "ready"
  | "generating"
  | "paused"
  | "auth_required"
  | "challenge_required"
  | "rate_limited"
  | "remote_error"
  | "unknown";

export interface ChatGptUiSnapshot {
  state: ChatGptUiState;
  message: string | null;
  actions: {
    stop: boolean;
    continue: boolean;
    retry: boolean;
    regenerate: boolean;
  };
}

async function firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function loginVisible(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (url.includes("/auth/login") || url.includes("/auth/signup")) return true;
  return page
    .getByRole("button", { name: /log in|login|로그인/i })
    .first()
    .isVisible()
    .catch(() => false);
}

export function isRateLimitMessage(value: string): boolean {
  return /rate limit|too many requests|too many messages|too many chats|usage limit|message limit|conversation limit|try again later|messages? too (?:frequently|quickly)|sending (?:messages|requests) too (?:frequently|quickly)|잠시 후 다시|사용량 한도|메시지 한도|채팅.*너무 자주|메시지.*너무 자주|너무 자주.*(?:채팅|메시지)/i.test(
    value
  );
}

async function challengeVisible(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (url.includes("/cdn-cgi/") || url.includes("challenge")) return true;

  const title = (await page.title().catch(() => "")).toLowerCase();
  if (
    title.includes("just a moment") ||
    title.includes("security verification") ||
    title.includes("verify you are human")
  ) {
    return true;
  }

  const challengeFrame = page.locator(
    [
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[title*="challenge" i]',
      'iframe[title*="verification" i]',
    ].join(", ")
  );
  if ((await challengeFrame.count().catch(() => 0)) > 0) return true;

  return page
    .getByText(
      /verify you are human|checking your browser|security verification|enable javascript and cookies|사람인지 확인|보안 확인/i
    )
    .first()
    .isVisible()
    .catch(() => false);
}

export async function detectChatGptUiState(page: Page): Promise<ChatGptUiSnapshot> {
  const stop = Boolean(await firstVisible(page, STOP_BUTTON_SELECTORS));
  const continued = Boolean(await firstVisible(page, CONTINUE_BUTTON_SELECTORS));
  const retry = Boolean(await firstVisible(page, RETRY_BUTTON_SELECTORS));
  const regenerate = Boolean(await firstVisible(page, REGENERATE_BUTTON_SELECTORS));
  const actions = { stop, continue: continued, retry, regenerate };

  if (await loginVisible(page)) {
    return { state: "auth_required", message: "ChatGPT login is required.", actions };
  }
  if (await challengeVisible(page)) {
    return {
      state: "challenge_required",
      message: "ChatGPT browser verification requires manual action.",
      actions,
    };
  }

  const alerts = uniqueOptions(
    await page.locator(GLOBAL_ERROR_SELECTOR).allInnerTexts().catch(() => [])
  );
  const joined = alerts.join(" | ");
  if (isRateLimitMessage(joined)) {
    return { state: "rate_limited", message: joined || "ChatGPT rate limit reached.", actions };
  }
  if (/something went wrong|network error|오류가 발생|문제가 발생/i.test(joined) || retry) {
    return {
      state: "remote_error",
      message: joined || "ChatGPT shows a retryable remote error.",
      actions,
    };
  }
  if (continued) return { state: "paused", message: null, actions };
  if (stop) return { state: "generating", message: null, actions };

  const composer = await firstVisible(page, PROMPT_SELECTORS);
  if (composer) return { state: "ready", message: null, actions };
  return { state: "unknown", message: null, actions };
}
