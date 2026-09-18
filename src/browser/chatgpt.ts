import fs from "node:fs";
import { Buffer } from "node:buffer";
import type { Locator, Page } from "playwright";
import {
  ASSISTANT_MESSAGE_SELECTOR,
  ATTACH_BUTTON_SELECTORS,
  ATTACHMENT_CHIP_SELECTOR,
  EFFORT_PICKER_SELECTORS,
  FILE_ASSET_SELECTOR,
  IMAGE_ASSET_SELECTOR,
  MODEL_PICKER_SELECTORS,
  PICKER_OPTION_SELECTOR,
  PROMPT_SELECTORS,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTORS,
  UPLOAD_BUSY_SELECTOR,
  UPLOAD_INPUT_SELECTORS,
  extractConversationId,
  extractProjectId,
  isValidConversationId,
  projectConversationUrl,
  normalizeText,
  truncateUtf8,
  uniqueOptions,
} from "./selectors.js";
import { detectChatGptUiState, type ChatGptUiSnapshot } from "./ui-state.js";
import {
  extractResponseManifest,
  type ResponseManifest,
} from "./response-extractor.js";
import { AssetStore, AssetStoreError, type SavedAsset } from "../assets/store.js";
import {
  InputStore,
  type InputAssetView,
  type ResolvedInputAsset,
} from "../inputs/store.js";
import { CHATGPT_ORIGIN, type AppConfig } from "../config.js";
import { BrowserRuntime } from "./runtime.js";
import {
  WorkspaceProjectManager,
  WorkspaceProjectError,
} from "../projects/browser.js";
import type {
  ProjectNamingMode,
  WorkspaceProjectBinding,
} from "../projects/store.js";

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
  | "PROMPT_TOO_LARGE"
  | "CONVERSATION_BUSY"
  | "UPLOAD_UNAVAILABLE"
  | "UPLOAD_UNCONFIRMED"
  | "ASSET_UNSAFE_ORIGIN"
  | "ASSET_RETRIEVAL_UNSUPPORTED";

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
  inputAssetIds?: string[];
  workspaceId?: string;
}

export interface BrowserTurnDispatch {
  conversationId: string | null;
  projectId: string | null;
  workspaceId: string | null;
  baselineAssistantCount: number;
}

export interface BrowserTurnSnapshot {
  conversationId: string | null;
  projectId: string | null;
  complete: boolean;
  paused: boolean;
  generating: boolean;
  response: string | null;
  responseBytes: number;
  truncated: boolean;
  manifest: ResponseManifest | null;
  ui: ChatGptUiSnapshot;
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

async function firstExisting(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) > 0) return locator;
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

function throwForUiState(ui: ChatGptUiSnapshot): void {
  if (ui.state === "auth_required") {
    throw new ChatGptWebError(
      "AUTH_REQUIRED",
      ui.message ?? "ChatGPT authentication is required."
    );
  }
  if (ui.state === "challenge_required") {
    throw new ChatGptWebError(
      "CHALLENGE_REQUIRED",
      ui.message ?? "ChatGPT browser verification requires manual action."
    );
  }
  if (ui.state === "rate_limited") {
    throw new ChatGptWebError("RATE_LIMITED", ui.message ?? "ChatGPT rate limit reached.");
  }
  if (ui.state === "remote_error") {
    throw new ChatGptWebError("REMOTE_ERROR", ui.message ?? "ChatGPT reported a remote error.");
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
  return message
    .locator('button[data-testid*="copy"], button[aria-label*="Copy" i], button[aria-label*="복사"]')
    .first()
    .isVisible()
    .catch(() => false);
}

function safeAssetUrl(value: string, base: string): URL {
  const url = new URL(value, base);
  if (url.protocol !== "https:") {
    throw new ChatGptWebError("ASSET_UNSAFE_ORIGIN", "Only HTTPS ChatGPT asset URLs are allowed.");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "chatgpt.com" ||
    host.endsWith(".chatgpt.com") ||
    host === "openai.com" ||
    host.endsWith(".openai.com") ||
    host === "oaiusercontent.com" ||
    host.endsWith(".oaiusercontent.com") ||
    host === "oaistatic.com" ||
    host.endsWith(".oaistatic.com");
  if (!allowed) {
    throw new ChatGptWebError(
      "ASSET_UNSAFE_ORIGIN",
      "Refusing to fetch an asset from an untrusted origin: " + host
    );
  }
  return url;
}

function decodeDataUrl(value: string): { bytes: Buffer; mime: string | null } {
  const match = value.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!match) {
    throw new ChatGptWebError("ASSET_RETRIEVAL_UNSUPPORTED", "Invalid data URL asset.");
  }
  const mime = match[1]?.trim() || null;
  const payload = match[3] ?? "";
  const bytes = match[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload));
  return { bytes, mime };
}

export class ChatGptWebClient {
  private readonly assetStore: AssetStore;
  private readonly inputStore: InputStore;
  private readonly projectManager: WorkspaceProjectManager;

  constructor(
    private readonly runtime: BrowserRuntime,
    private readonly config: AppConfig
  ) {
    this.assetStore = new AssetStore(config.stateDir);
    this.inputStore = new InputStore(config.stateDir, config);
    this.projectManager = new WorkspaceProjectManager(runtime, config);
    this.inputStore.cleanup();
  }

  private async navigate(
    page: Page,
    conversationId?: string,
    projectId?: string | null
  ): Promise<void> {
    if (conversationId !== undefined) {
      if (!isValidConversationId(conversationId)) {
        throw new Error("Invalid ChatGPT conversation id.");
      }
      const target = projectId
        ? projectConversationUrl(projectId, conversationId)
        : CHATGPT_ORIGIN + "/c/" + conversationId;
      const response = await page.goto(target, {
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
      const ui = await detectChatGptUiState(page);
      throwForUiState(ui);
      const actual = extractConversationId(page.url());
      if (actual !== conversationId) {
        throw new ChatGptWebError(
          actual ? "SESSION_LOST" : "CONVERSATION_NOT_FOUND",
          actual
            ? "ChatGPT opened a different conversation than requested."
            : "ChatGPT did not remain on the requested conversation."
        );
      }
      if (projectId && extractProjectId(page.url()) !== projectId) {
        throw new WorkspaceProjectError(
          "PROJECT_DESTINATION_MISMATCH",
          "Conversation opened outside the ChatGPT Project bound to this workspace."
        );
      }
      return;
    }

    await page.goto(CHATGPT_ORIGIN, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    throwForUiState(await detectChatGptUiState(page));
  }

  private async ensureConversation(
    page: Page,
    conversationId: string | null,
    projectId: string | null
  ): Promise<void> {
    if (!conversationId) {
      const deadline = Date.now() + 5_000;
      let current = extractConversationId(page.url());
      while (!current && Date.now() < deadline) {
        throwForUiState(await detectChatGptUiState(page));
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
    if (
      extractConversationId(page.url()) === conversationId &&
      (!projectId || extractProjectId(page.url()) === projectId)
    ) return;
    await this.navigate(page, conversationId, projectId);
  }

  private async requireComposer(page: Page): Promise<Locator> {
    const composer = await waitForFirstVisible(page, PROMPT_SELECTORS, 15_000);
    if (composer) return composer;
    const ui = await detectChatGptUiState(page);
    throwForUiState(ui);
    throw new ChatGptWebError(
      "UI_CHANGED",
      "Could not find the ChatGPT prompt composer. The web UI may have changed."
    );
  }

  async status(): Promise<{
    authenticated: boolean;
    uiReady: boolean;
    conversationId: string | null;
    projectId: string | null;
    headless: boolean;
    ui: ChatGptUiSnapshot;
  }> {
    const page = await this.runtime.newPage();
    try {
      await page.goto(CHATGPT_ORIGIN, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const ui = await detectChatGptUiState(page);
      const composer = await waitForFirstVisible(page, PROMPT_SELECTORS, 2_000);
      const authenticated = !["auth_required", "challenge_required"].includes(ui.state);
      return {
        authenticated,
        uiReady: Boolean(composer) && ["ready", "generating", "paused"].includes(ui.state),
        conversationId: extractConversationId(page.url()),
        projectId: extractProjectId(page.url()),
        headless: this.runtime.headless,
        ui,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async capabilities(): Promise<ChatGptCapabilities> {
    const page = await this.runtime.newPage();
    try {
      await this.navigate(page);
      await this.requireComposer(page);
      const modelPicker = await pickerInfo(page, MODEL_PICKER_SELECTORS);
      const effortPicker = await pickerInfo(page, EFFORT_PICKER_SELECTORS);
      return {
        modelPicker,
        effortPicker,
        flattenedPicker: modelPicker.found && !effortPicker.found,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async bindWorkspaceProject(input: {
    workspaceId: string;
    workspaceName?: string;
    namingMode?: ProjectNamingMode;
  }): Promise<WorkspaceProjectBinding> {
    const state = await this.status();
    throwForUiState(state.ui);
    if (!state.authenticated) {
      throw new ChatGptWebError(
        "AUTH_REQUIRED",
        "ChatGPT authentication is required before binding a workspace project."
      );
    }
    return this.projectManager.bindWorkspace(input);
  }

  listWorkspaceProjects(): WorkspaceProjectBinding[] {
    return this.projectManager.listBindings();
  }

  getWorkspaceProject(workspaceId: string): WorkspaceProjectBinding {
    return this.projectManager.getBinding(workspaceId);
  }

  unbindWorkspaceProject(workspaceId: string) {
    return this.projectManager.unbind(workspaceId);
  }

  stageTextInput(input: { filename: string; content: string; mime?: string }): InputAssetView {
    return this.inputStore.stageText(input);
  }

  stageBlobInput(input: { filename: string; mime: string; dataBase64: string }): InputAssetView {
    return this.inputStore.stageBlob(input);
  }

  createBlobInputSlot(input: {
    filename: string;
    mime: string;
  }) {
    return this.inputStore.createBlobSlot(input);
  }

  commitBlobInputSlot(slotId: string): InputAssetView {
    return this.inputStore.commitBlobSlot(slotId);
  }

  listStagedInputs(): InputAssetView[] {
    return this.inputStore.list();
  }

  discardStagedInput(inputAssetId: string): { inputAssetId: string; discarded: boolean } {
    return { inputAssetId, discarded: this.inputStore.discard(inputAssetId) };
  }

  cleanupStagedInputs(): { removed: number } {
    return { removed: this.inputStore.cleanup() };
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

  private async composerScope(page: Page): Promise<Locator> {
    const composer = await this.requireComposer(page);
    const form = composer.locator("xpath=ancestor::form[1]");
    if ((await form.count().catch(() => 0)) > 0) return form.first();

    const withFileInput = composer.locator(
      'xpath=ancestor::*[descendant::input[@type="file"]][1]'
    );
    if ((await withFileInput.count().catch(() => 0)) > 0) return withFileInput.first();

    return composer.locator("xpath=..");
  }

  private async uploadInputBatch(
    page: Page,
    uploadInput: Locator,
    assets: ResolvedInputAsset[],
    beforeChips: number
  ): Promise<void> {
    const paths = assets.map((asset) => asset.path);
    const filenames = assets.map((asset) => asset.record.filename);
    await uploadInput.setInputFiles(paths);

    const deadline = Date.now() + 30_000;
    let confirmedSince: number | null = null;
    while (Date.now() < deadline) {
      const ui = await detectChatGptUiState(page);
      throwForUiState(ui);

      const scope = await this.composerScope(page);
      let named = 0;
      for (const filename of filenames) {
        const visible = await scope
          .getByText(filename, { exact: true })
          .last()
          .isVisible()
          .catch(() => false);
        if (visible) named++;
      }

      const chipCount = await scope.locator(ATTACHMENT_CHIP_SELECTOR).count().catch(() => 0);
      const busy = await scope.locator(UPLOAD_BUSY_SELECTOR).first().isVisible().catch(() => false);
      const fileCount = await uploadInput
        .evaluate((node) => (node as HTMLInputElement).files?.length ?? 0)
        .catch(() => 0);
      const sendReady = await firstVisible(page, SEND_BUTTON_SELECTORS)
        .then((button) => button?.isEnabled().catch(() => false) ?? false)
        .catch(() => false);

      const strongEvidence =
        named === filenames.length ||
        chipCount >= beforeChips + filenames.length;
      const fallbackEvidence =
        fileCount === filenames.length && sendReady;

      if ((strongEvidence || fallbackEvidence) && !busy) {
        confirmedSince ??= Date.now();
        if (Date.now() - confirmedSince >= 750) {
          throwForUiState(await detectChatGptUiState(page));
          return;
        }
      } else {
        confirmedSince = null;
      }
      await page.waitForTimeout(250);
    }

    throw new ChatGptWebError(
      "UPLOAD_UNCONFIRMED",
      "ChatGPT did not expose a stable attachment state before the upload timeout; prompt was not sent."
    );
  }

  private async requireUploadInput(page: Page): Promise<Locator> {
    let scope = await this.composerScope(page);
    let uploadInput: Locator | null = null;
    for (const selector of UPLOAD_INPUT_SELECTORS) {
      const candidate = scope.locator(selector).first();
      if ((await candidate.count().catch(() => 0)) > 0) {
        uploadInput = candidate;
        break;
      }
    }
    if (uploadInput) return uploadInput;

    let attach: Locator | null = null;
    for (const selector of ATTACH_BUTTON_SELECTORS) {
      const candidate = scope.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) {
        attach = candidate;
        break;
      }
    }
    if (!attach) {
      throw new ChatGptWebError(
        "UPLOAD_UNAVAILABLE",
        "Could not find a safe attachment control inside the ChatGPT composer."
      );
    }
    await attach.click();
    await page.waitForTimeout(250);
    scope = await this.composerScope(page);
    for (const selector of UPLOAD_INPUT_SELECTORS) {
      const candidate = scope.locator(selector).first();
      if ((await candidate.count().catch(() => 0)) > 0) {
        uploadInput = candidate;
        break;
      }
    }
    if (!uploadInput) {
      throw new ChatGptWebError(
        "UPLOAD_UNAVAILABLE",
        "Attachment control opened but no composer-scoped file input became available."
      );
    }
    return uploadInput;
  }

  private async uploadInputs(page: Page, assets: ResolvedInputAsset[]): Promise<void> {
    if (assets.length === 0) return;

    const ui = await detectChatGptUiState(page);
    throwForUiState(ui);
    if (ui.state === "generating" || ui.state === "paused") {
      throw new ChatGptWebError(
        "CONVERSATION_BUSY",
        "Cannot attach files while the current ChatGPT conversation is generating or paused."
      );
    }
    if (ui.state !== "ready") {
      throw new ChatGptWebError(
        "UI_CHANGED",
        "ChatGPT composer is not in a known ready state for attachment upload."
      );
    }

    let uploadInput = await this.requireUploadInput(page);
    const multiple = (await uploadInput.getAttribute("multiple")) !== null;
    let scope = await this.composerScope(page);
    let beforeChips = await scope.locator(ATTACHMENT_CHIP_SELECTOR).count().catch(() => 0);

    if (multiple || assets.length === 1) {
      await this.uploadInputBatch(page, uploadInput, assets, beforeChips);
      return;
    }

    for (const asset of assets) {
      uploadInput = await this.requireUploadInput(page);
      await this.uploadInputBatch(page, uploadInput, [asset], beforeChips);
      scope = await this.composerScope(page);
      beforeChips = await scope.locator(ATTACHMENT_CHIP_SELECTOR).count().catch(() => beforeChips + 1);
    }
  }

  async dispatch(input: BrowserDispatchRequest): Promise<BrowserTurnDispatch> {
    if (this.config.requireWorkspaceProject && !input.workspaceId) {
      throw new WorkspaceProjectError(
        "WORKSPACE_REQUIRED",
        "A workspace_id is required by default so new ChatGPT chats stay inside a Project with Project-only memory. Set CGW_REQUIRE_WORKSPACE_PROJECT=false only for intentional legacy/general-chat use."
      );
    }

    const promptBytes = Buffer.byteLength(input.prompt, "utf8");
    if (promptBytes === 0) throw new Error("Prompt must not be empty.");
    if (promptBytes > this.config.maxPromptBytes) {
      throw new ChatGptWebError(
        "PROMPT_TOO_LARGE",
        "Prompt is " + promptBytes + " UTF-8 bytes; limit is " + this.config.maxPromptBytes + "."
      );
    }

    const resolvedInputs = this.inputStore.resolve(input.inputAssetIds ?? []);

    let page: Page;
    let expectedProjectId: string | null = null;
    if (input.workspaceId) {
      const binding = this.projectManager.getBinding(input.workspaceId);
      expectedProjectId = binding.projectId;
      if (input.conversationId) {
        page = await this.runtime.page();
        await this.navigate(page, input.conversationId, expectedProjectId);
      } else {
        const opened = await this.projectManager.openBoundProject(input.workspaceId);
        page = opened.page;
      }
    } else {
      page = await this.runtime.page();
      await this.navigate(page, input.conversationId);
    }

    if (expectedProjectId && extractProjectId(page.url()) !== expectedProjectId) {
      throw new WorkspaceProjectError(
        "PROJECT_DESTINATION_MISMATCH",
        "Composer is not inside the ChatGPT Project bound to this workspace."
      );
    }
    if (input.workspaceId) {
      await this.projectManager.assertPageBoundToWorkspace(page, input.workspaceId);
    }

    const composer = await this.requireComposer(page);
    const preSendUi = await detectChatGptUiState(page);
    throwForUiState(preSendUi);
    if (preSendUi.state === "generating" || preSendUi.state === "paused") {
      throw new ChatGptWebError(
        "CONVERSATION_BUSY",
        "Cannot send a new turn while the current conversation is generating or paused."
      );
    }
    await this.applySelections(page, input.model, input.effort);

    const baselineAssistantCount = await page.locator(ASSISTANT_MESSAGE_SELECTOR).count();
    await composer.fill(input.prompt);
    await page.waitForTimeout(100);
    await this.uploadInputs(page, resolvedInputs);

    const send = await firstVisible(page, SEND_BUTTON_SELECTORS);
    if (send && (await send.isEnabled().catch(() => false))) await send.click();
    else await composer.press("Enter");

    const deadline = Date.now() + 10_000;
    let conversationId = input.conversationId ?? extractConversationId(page.url());
    while (!conversationId && Date.now() < deadline) {
      throwForUiState(await detectChatGptUiState(page));
      await page.waitForTimeout(250);
      conversationId = extractConversationId(page.url());
    }

    const landedProjectId = extractProjectId(page.url());
    if (expectedProjectId && landedProjectId !== expectedProjectId) {
      throw new WorkspaceProjectError(
        "PROJECT_DESTINATION_MISMATCH",
        "Prompt landed outside the ChatGPT Project bound to this workspace."
      );
    }

    return {
      conversationId,
      projectId: landedProjectId,
      workspaceId: input.workspaceId ?? null,
      baselineAssistantCount,
    };
  }

  private async manifestFor(
    page: Page,
    baselineAssistantCount: number
  ): Promise<ResponseManifest | null> {
    const messages = page.locator(ASSISTANT_MESSAGE_SELECTOR);
    const count = await messages.count();
    if (count <= baselineAssistantCount) return null;
    const conversationId = extractConversationId(page.url());
    if (!conversationId) return null;
    const assistantIndex = count - 1;
    return extractResponseManifest({
      message: messages.nth(assistantIndex),
      conversationId,
      projectId: extractProjectId(page.url()),
      assistantIndex,
      assetStore: this.assetStore,
    });
  }

  async inspectTurn(input: {
    conversationId: string | null;
    projectId: string | null;
    baselineAssistantCount: number;
    timeoutMs: number;
  }): Promise<BrowserTurnSnapshot> {
    const page = await this.runtime.page();
    await this.ensureConversation(page, input.conversationId, input.projectId);

    const deadline = Date.now() + Math.max(0, input.timeoutMs);
    let lastText = "";
    let stableSince = Date.now();
    let first = true;

    do {
      const ui = await detectChatGptUiState(page);
      throwForUiState(ui);
      const messages = page.locator(ASSISTANT_MESSAGE_SELECTOR);
      const count = await messages.count();

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
      const paused = ui.state === "paused";
      const generating = ui.state === "generating";
      const complete =
        Boolean(response) &&
        !generating &&
        !paused &&
        (copyVisible || (ui.state === "ready" && stableLongEnough));

      if (complete || paused || input.timeoutMs === 0) {
        const bounded = truncateUtf8(response ?? "", this.config.maxResponseBytes);
        return {
          conversationId: extractConversationId(page.url()) ?? input.conversationId,
          projectId: extractProjectId(page.url()) ?? input.projectId,
          complete,
          paused,
          generating: !complete && !paused,
          response: response === null ? null : bounded.text,
          responseBytes: bounded.bytes,
          truncated: bounded.truncated,
          manifest: response === null ? null : await this.manifestFor(page, input.baselineAssistantCount),
          ui,
        };
      }

      first = false;
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(500);
    } while (first || Date.now() <= deadline);

    const ui = await detectChatGptUiState(page);
    throwForUiState(ui);
    const messages = page.locator(ASSISTANT_MESSAGE_SELECTOR);
    const count = await messages.count();
    const response =
      count > input.baselineAssistantCount
        ? preserveMessageText(await messages.last().innerText().catch(() => ""))
        : null;
    const bounded = truncateUtf8(response ?? "", this.config.maxResponseBytes);
    return {
      conversationId: extractConversationId(page.url()) ?? input.conversationId,
      projectId: extractProjectId(page.url()) ?? input.projectId,
      complete: false,
      paused: ui.state === "paused",
      generating: ui.state === "generating" || Boolean(response),
      response: response === null ? null : bounded.text,
      responseBytes: bounded.bytes,
      truncated: bounded.truncated,
      manifest: response === null ? null : await this.manifestFor(page, input.baselineAssistantCount),
      ui,
    };
  }

  async stopTurn(input: {
    conversationId: string | null;
    projectId: string | null;
    baselineAssistantCount: number;
  }): Promise<BrowserTurnSnapshot> {
    const page = await this.runtime.page();
    await this.ensureConversation(page, input.conversationId, input.projectId);
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
      projectId: extractProjectId(page.url()) ?? input.projectId,
      baselineAssistantCount: input.baselineAssistantCount,
      timeoutMs: 0,
    });
  }

  private async meaningfulImage(message: Locator, ordinal: number): Promise<Locator> {
    const images = message.locator(IMAGE_ASSET_SELECTOR);
    const count = await images.count();
    let seen = 0;
    for (let index = 0; index < count; index++) {
      const image = images.nth(index);
      const meaningful = await image
        .evaluate((node) => {
          const img = node as HTMLImageElement;
          const rect = img.getBoundingClientRect();
          const width = img.naturalWidth || rect.width || Number(img.getAttribute("width")) || 0;
          const height = img.naturalHeight || rect.height || Number(img.getAttribute("height")) || 0;
          return width >= 48 || height >= 48 || Boolean(img.getAttribute("alt")?.trim());
        })
        .catch(() => false);
      if (!meaningful) continue;
      if (seen === ordinal) return image;
      seen++;
    }
    throw new AssetStoreError("ASSET_NOT_FOUND", "Image asset is no longer present in the response.");
  }

  private async readAssetHref(record: ReturnType<AssetStore["get"]>, message: Locator): Promise<{
    href: string;
    filename: string | null;
    mime: string | null;
  }> {
    if (record.kind === "image") {
      const image = await this.meaningfulImage(message, record.ordinal);
      const src = await image.getAttribute("src");
      if (!src) {
        throw new ChatGptWebError("ASSET_RETRIEVAL_UNSUPPORTED", "Image has no retrievable src.");
      }
      return {
        href: src,
        filename: record.filename,
        mime: await image.getAttribute("type"),
      };
    }

    const candidates = message.locator(FILE_ASSET_SELECTOR);
    if ((await candidates.count()) <= record.ordinal) {
      throw new AssetStoreError("ASSET_NOT_FOUND", "File asset is no longer present in the response.");
    }
    const candidate = candidates.nth(record.ordinal);
    let href = await candidate.getAttribute("href");
    let filename = await candidate.getAttribute("download");
    if (!href) {
      const anchor = candidate.locator("a[href]").first();
      if (await anchor.count()) {
        href = await anchor.getAttribute("href");
        filename = filename ?? (await anchor.getAttribute("download"));
      }
    }
    if (!href) {
      throw new ChatGptWebError(
        "ASSET_RETRIEVAL_UNSUPPORTED",
        "This file card has no safe direct asset URL. The proxy will not click an opaque download control."
      );
    }
    return {
      href,
      filename: filename ?? record.filename,
      mime:
        (await candidate.getAttribute("data-mime")) ??
        (await candidate.getAttribute("data-mime-type")) ??
        record.mime,
    };
  }

  private async downloadOpaqueFile(
    page: Page,
    record: ReturnType<AssetStore["get"]>,
    message: Locator
  ): Promise<SavedAsset> {
    const candidates = message.locator(FILE_ASSET_SELECTOR);
    if ((await candidates.count()) <= record.ordinal) {
      throw new AssetStoreError("ASSET_NOT_FOUND", "File asset is no longer present in the response.");
    }
    const candidate = candidates.nth(record.ordinal);
    let target = candidate;
    const nested = candidate
      .locator('a[download], button[data-testid*="download"], button[aria-label*="download" i]')
      .first();
    if (await nested.count()) target = nested;

    const beforeUrl = page.url();
    try {
      const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
      await target.click();
      const download = await downloadPromise;
      const failure = await download.failure();
      if (failure) {
        throw new ChatGptWebError("ASSET_RETRIEVAL_UNSUPPORTED", "ChatGPT download failed: " + failure);
      }
      const tempPath = await download.path();
      if (!tempPath) {
        throw new ChatGptWebError(
          "ASSET_RETRIEVAL_UNSUPPORTED",
          "ChatGPT download completed without a readable temporary file."
        );
      }
      const stat = fs.statSync(tempPath);
      if (stat.size > this.config.maxAssetBytes) {
        await download.delete().catch(() => undefined);
        throw new AssetStoreError(
          "ASSET_TOO_LARGE",
          "Downloaded asset is " + stat.size + " bytes; limit is " + this.config.maxAssetBytes + "."
        );
      }
      const bytes = fs.readFileSync(tempPath);
      const saved = this.assetStore.save(record, bytes, {
        filename: download.suggestedFilename() || record.filename,
        mime: record.mime,
        maxBytes: this.config.maxAssetBytes,
      });
      await download.delete().catch(() => undefined);
      return saved;
    } catch (error) {
      if (page.url() !== beforeUrl) {
        await this.navigate(page, record.conversationId, record.projectId ?? null).catch(() => undefined);
      }
      throw error;
    }
  }

  async getAsset(assetId: string): Promise<SavedAsset> {
    const record = this.assetStore.get(assetId);
    const page = await this.runtime.page();
    await this.navigate(page, record.conversationId, record.projectId ?? null);

    const messages = page.locator(ASSISTANT_MESSAGE_SELECTOR);
    if ((await messages.count()) <= record.assistantIndex) {
      throw new AssetStoreError("ASSET_NOT_FOUND", "Assistant response containing the asset is unavailable.");
    }
    const message = messages.nth(record.assistantIndex);
    let source: { href: string; filename: string | null; mime: string | null };
    try {
      source = await this.readAssetHref(record, message);
    } catch (error) {
      if (
        record.kind === "file" &&
        error instanceof ChatGptWebError &&
        error.code === "ASSET_RETRIEVAL_UNSUPPORTED"
      ) {
        return this.downloadOpaqueFile(page, record, message);
      }
      throw error;
    }

    let bytes: Buffer;
    let mime = source.mime;
    if (source.href.startsWith("data:")) {
      if (source.href.length > this.config.maxAssetBytes * 2) {
        throw new AssetStoreError("ASSET_TOO_LARGE", "Encoded data URL exceeds the configured asset limit.");
      }
      const decoded = decodeDataUrl(source.href);
      bytes = decoded.bytes;
      mime = mime ?? decoded.mime;
    } else if (source.href.startsWith("blob:")) {
      const encoded = await page.evaluate(async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error("blob fetch failed");
        const buffer = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        const step = 0x8000;
        for (let i = 0; i < buffer.length; i += step) {
          binary += String.fromCharCode(...buffer.subarray(i, i + step));
        }
        return { base64: btoa(binary), type: response.headers.get("content-type") };
      }, source.href);
      if (encoded.base64.length > this.config.maxAssetBytes * 2) {
        throw new AssetStoreError("ASSET_TOO_LARGE", "Encoded blob exceeds the configured asset limit.");
      }
      bytes = Buffer.from(encoded.base64, "base64");
      mime = mime ?? encoded.type;
    } else {
      let url = safeAssetUrl(source.href, page.url());
      let response = await page.context().request.get(url.toString(), {
        timeout: 30_000,
        maxRedirects: 0,
      });
      for (let redirect = 0; redirect < 5 && response.status() >= 300 && response.status() < 400; redirect++) {
        const location = response.headers()["location"];
        if (!location) break;
        url = safeAssetUrl(location, url.toString());
        response = await page.context().request.get(url.toString(), {
          timeout: 30_000,
          maxRedirects: 0,
        });
      }
      if (!response.ok()) {
        throw new ChatGptWebError(
          "ASSET_RETRIEVAL_UNSUPPORTED",
          "ChatGPT asset request failed with HTTP " + response.status() + "."
        );
      }
      safeAssetUrl(response.url(), url.toString());
      const contentLength = Number(response.headers()["content-length"] ?? "0");
      if (contentLength > this.config.maxAssetBytes) {
        throw new AssetStoreError(
          "ASSET_TOO_LARGE",
          "Asset declares " + contentLength + " bytes; limit is " + this.config.maxAssetBytes + "."
        );
      }
      bytes = Buffer.from(await response.body());
      if (bytes.length > this.config.maxAssetBytes) {
        throw new AssetStoreError(
          "ASSET_TOO_LARGE",
          "Asset body is " + bytes.length + " bytes; limit is " + this.config.maxAssetBytes + "."
        );
      }
      mime = mime ?? response.headers()["content-type"] ?? null;
    }

    return this.assetStore.save(record, bytes, {
      filename: source.filename,
      mime,
      maxBytes: this.config.maxAssetBytes,
    });
  }
}
