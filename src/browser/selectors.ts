import { Buffer } from "node:buffer";

export const PROMPT_SELECTORS = [
  "#prompt-textarea",
  "[data-testid=\"prompt-textarea\"]",
  "[contenteditable=\"true\"][role=\"textbox\"]",
  "textarea[placeholder*=\"Message\" i]",
  "textarea[placeholder*=\"메시지\"]",
] as const;

export const SEND_BUTTON_SELECTORS = [
  "button[data-testid=\"send-button\"]",
  "button[aria-label*=\"Send\" i]",
  "button[aria-label*=\"보내기\"]",
] as const;

export const STOP_BUTTON_SELECTORS = [
  "button[data-testid=\"stop-button\"]",
  "button[aria-label*=\"Stop\" i]",
  "button[aria-label*=\"중지\"]",
] as const;

export const CONTINUE_BUTTON_SELECTORS = [
  "button:has-text(\"Continue generating\")",
  "button:has-text(\"계속 생성\")",
] as const;

export const COPY_BUTTON_SELECTORS = [
  "button[data-testid*=\"copy\"]",
  "button[aria-label*=\"Copy\" i]",
  "button[aria-label*=\"복사\"]",
] as const;

export const MODEL_PICKER_SELECTORS = [
  "[data-testid=\"model-switcher-dropdown-button\"]",
  "button[data-testid*=\"model-switcher\"]",
  "button[aria-label*=\"model\" i]",
  "button[aria-label*=\"모델\"]",
] as const;

export const EFFORT_PICKER_SELECTORS = [
  "button[data-testid*=\"reasoning\"]",
  "button[data-testid*=\"thinking\"]",
  "button[aria-label*=\"reasoning\" i]",
  "button[aria-label*=\"thinking\" i]",
  "button[aria-label*=\"추론\"]",
] as const;

export const PICKER_OPTION_SELECTOR =
  "[role=\"menuitem\"]:visible, [role=\"menuitemradio\"]:visible, [role=\"option\"]:visible";

export const ASSISTANT_MESSAGE_SELECTOR = "[data-message-author-role=\"assistant\"]";
export const GLOBAL_ERROR_SELECTOR =
  "[role=\"alert\"]:visible, [data-testid*=\"error\"]:visible";

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function uniqueOptions(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = normalizeText(raw);
    if (!value || value.length > 200 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function extractConversationId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "www.chatgpt.com") return null;
    const match = parsed.pathname.match(/^\/c\/([A-Za-z0-9-]{8,128})(?:\/)?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function isValidConversationId(value: string): boolean {
  return /^[A-Za-z0-9-]{8,128}$/.test(value);
}

export function truncateUtf8(
  input: string,
  maxBytes: number
): { text: string; truncated: boolean; bytes: number } {
  const total = Buffer.byteLength(input, "utf8");
  if (total <= maxBytes) return { text: input, truncated: false, bytes: total };

  let used = 0;
  let text = "";
  for (const char of input) {
    const cost = Buffer.byteLength(char, "utf8");
    if (used + cost > maxBytes) break;
    text += char;
    used += cost;
  }
  return { text, truncated: true, bytes: used };
}
