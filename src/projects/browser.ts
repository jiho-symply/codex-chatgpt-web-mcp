import type { Locator, Page } from "playwright";
import { CHATGPT_ORIGIN, type AppConfig } from "../config.js";
import { BrowserRuntime } from "../browser/runtime.js";
import {
  extractProjectId,
  isValidProjectId,
  projectHomeUrl,
} from "../browser/selectors.js";
import {
  ProjectNamingMode,
  WorkspaceProjectStore,
  WorkspaceProjectStoreError,
  projectNameFor,
  sanitizeWorkspaceName,
  validateWorkspaceId,
  type WorkspaceProjectBinding,
} from "./store.js";

export type WorkspaceProjectErrorCode =
  | "PROJECT_CREATE_UNAVAILABLE"
  | "PROJECT_MEMORY_UNAVAILABLE"
  | "PROJECT_MEMORY_UNVERIFIED"
  | "PROJECT_CREATE_FAILED"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NAVIGATION_FAILED"
  | "PROJECT_DESTINATION_MISMATCH";

export class WorkspaceProjectError extends Error {
  constructor(
    public readonly code: WorkspaceProjectErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceProjectError";
  }
}

const NEW_PROJECT_SELECTORS = [
  'button[aria-label="New project"]',
  'button[aria-label="새 프로젝트"]',
  'button[data-testid*="new-project"]',
  'button[data-testid*="create-project"]',
] as const;

const PROJECT_NAME_INPUT_SELECTORS = [
  'input[placeholder*="project name" i]',
  'input[placeholder*="프로젝트 이름"]',
  'input[name*="project" i]',
] as const;

const MORE_OPTIONS_LABEL = /more options|advanced|추가 옵션|고급/i;
const PROJECT_ONLY_LABEL = /project[- ]only memory|project only|프로젝트 전용 메모리|프로젝트만/i;
const CREATE_PROJECT_LABEL = /create project|create|프로젝트 만들기|프로젝트 생성|생성/i;

async function firstVisible(scope: Page | Locator, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function projectDialog(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog").last();
  if (await dialog.isVisible().catch(() => false)) return dialog;
  return page.locator("body");
}

async function visibleProjectOnly(scope: Locator): Promise<Locator | null> {
  const radio = scope.getByRole("radio", { name: PROJECT_ONLY_LABEL }).first();
  if (await radio.isVisible().catch(() => false)) return radio;

  const option = scope.getByRole("option", { name: PROJECT_ONLY_LABEL }).first();
  if (await option.isVisible().catch(() => false)) return option;

  const button = scope.getByRole("button", { name: PROJECT_ONLY_LABEL }).first();
  if (await button.isVisible().catch(() => false)) return button;

  const text = scope.getByText(PROJECT_ONLY_LABEL).first();
  if (await text.isVisible().catch(() => false)) return text;
  return null;
}

async function selectionLooksProjectOnly(scope: Locator): Promise<boolean> {
  const checked = scope.getByRole("radio", { name: PROJECT_ONLY_LABEL }).first();
  if (await checked.isVisible().catch(() => false)) {
    if (await checked.isChecked().catch(() => false)) return true;
    if ((await checked.getAttribute("aria-checked").catch(() => null)) === "true") return true;
  }

  const selectedOption = scope.getByRole("option", { name: PROJECT_ONLY_LABEL }).first();
  if (await selectedOption.isVisible().catch(() => false)) {
    if ((await selectedOption.getAttribute("aria-selected").catch(() => null)) === "true") return true;
  }

  const candidates = scope.locator('[aria-checked="true"], [aria-selected="true"], [data-state="checked"], [data-state="active"]');
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const text = (await candidates.nth(i).innerText().catch(() => "")).trim();
    const aria = (await candidates.nth(i).getAttribute("aria-label").catch(() => null)) ?? "";
    if (PROJECT_ONLY_LABEL.test(text) || PROJECT_ONLY_LABEL.test(aria)) return true;
  }

  const controls = scope.locator('button, [role="combobox"]');
  const controlCount = await controls.count().catch(() => 0);
  for (let i = 0; i < controlCount; i++) {
    const text = (await controls.nth(i).innerText().catch(() => "")).trim();
    if (PROJECT_ONLY_LABEL.test(text)) return true;
  }
  return false;
}

async function selectProjectOnlyMemory(page: Page, scope: Locator): Promise<void> {
  let option = await visibleProjectOnly(scope);
  if (!option) {
    const more = scope.getByRole("button", { name: MORE_OPTIONS_LABEL }).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      await page.waitForTimeout(200);
      option = await visibleProjectOnly(scope);
    }
  }

  if (!option) {
    const memoryControl = scope.getByRole("button", { name: /memory|메모리/i }).first();
    const memoryCombo = scope.getByRole("combobox", { name: /memory|메모리/i }).first();
    const control = (await memoryControl.isVisible().catch(() => false))
      ? memoryControl
      : (await memoryCombo.isVisible().catch(() => false))
        ? memoryCombo
        : null;
    if (control) {
      await control.click();
      await page.waitForTimeout(200);
      option = await visibleProjectOnly(await projectDialog(page));
    }
  }

  if (!option) {
    throw new WorkspaceProjectError(
      "PROJECT_MEMORY_UNAVAILABLE",
      "The new-project UI did not expose Project-only memory. Refusing to create a default-memory project."
    );
  }

  await option.click();
  await page.waitForTimeout(200);
  const current = await projectDialog(page);
  if (!(await selectionLooksProjectOnly(current))) {
    throw new WorkspaceProjectError(
      "PROJECT_MEMORY_UNVERIFIED",
      "Project-only memory could not be verified before project creation."
    );
  }
}

function canonicalProjectIdFromHref(href: string | null): string | null {
  if (!href) return null;
  try {
    return extractProjectId(new URL(href, CHATGPT_ORIGIN).toString());
  } catch {
    return null;
  }
}

export class WorkspaceProjectManager {
  private readonly store: WorkspaceProjectStore;

  constructor(
    private readonly runtime: BrowserRuntime,
    private readonly config: AppConfig
  ) {
    this.store = new WorkspaceProjectStore(config.stateDir);
  }

  getBinding(workspaceId: string): WorkspaceProjectBinding {
    return this.store.get(workspaceId);
  }

  listBindings(): WorkspaceProjectBinding[] {
    return this.store.list();
  }

  unbind(workspaceId: string): { workspaceId: string; unbound: boolean; remoteProjectDeleted: false } {
    const id = validateWorkspaceId(workspaceId);
    return { workspaceId: id, unbound: this.store.remove(id), remoteProjectDeleted: false };
  }

  private async rootPage(): Promise<Page> {
    const page = await this.runtime.page();
    await page.goto(CHATGPT_ORIGIN, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return page;
  }

  private async findSidebarProject(page: Page, binding: WorkspaceProjectBinding): Promise<Locator | null> {
    const links = page.locator('a[href*="/g/g-p-"]');
    const count = await links.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const link = links.nth(i);
      if (!(await link.isVisible().catch(() => false))) continue;
      const href = await link.getAttribute("href").catch(() => null);
      if (canonicalProjectIdFromHref(href) === binding.projectId) return link;
    }

    const exact = page.getByText(binding.projectName, { exact: true }).first();
    if (await exact.isVisible().catch(() => false)) {
      const row = exact.locator("xpath=ancestor::*[self::li or @role='treeitem' or @role='listitem'][1]");
      if ((await row.count().catch(() => 0)) > 0) {
        const home = row.locator(
          'a[href*="/g/g-p-"], button[aria-label*="project home" i], button[aria-label*="프로젝트 홈"]'
        ).first();
        if (await home.isVisible().catch(() => false)) return home;
      }
      const parentLink = exact.locator('xpath=ancestor::a[contains(@href,"/g/g-p-")][1]');
      if ((await parentLink.count().catch(() => 0)) > 0) return parentLink.first();
    }
    return null;
  }

  async openBoundProject(workspaceId: string): Promise<{
    page: Page;
    binding: WorkspaceProjectBinding;
  }> {
    const binding = this.store.get(workspaceId);
    if (binding.status !== "ready" || binding.memoryMode !== "project-only" || !binding.memoryVerifiedAt) {
      throw new WorkspaceProjectError(
        "PROJECT_MEMORY_UNVERIFIED",
        "Workspace project exists locally but Project-only memory is not verified."
      );
    }

    let page = await this.runtime.page();
    if (extractProjectId(page.url()) === binding.projectId) {
      return { page, binding };
    }

    page = await this.rootPage();
    const target = await this.findSidebarProject(page, binding);
    if (target) {
      await target.click();
    } else {
      // Fallback only to the exact locally stored project URL; never search/adopt by name.
      await page.goto(binding.projectUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const observed = extractProjectId(page.url());
      if (observed === binding.projectId) return { page, binding };
      if (observed && observed !== binding.projectId) {
        throw new WorkspaceProjectError(
          "PROJECT_DESTINATION_MISMATCH",
          "ChatGPT navigated to a different project than the workspace binding."
        );
      }
      await page.waitForTimeout(250);
    }

    throw new WorkspaceProjectError(
      "PROJECT_NAVIGATION_FAILED",
      "Could not reopen the exact ChatGPT Project bound to this workspace. It may have been deleted or the UI changed."
    );
  }

  async bindWorkspace(input: {
    workspaceId: string;
    workspaceName?: string;
    namingMode?: ProjectNamingMode;
  }): Promise<WorkspaceProjectBinding> {
    const workspaceId = validateWorkspaceId(input.workspaceId);
    const existing = this.store.find(workspaceId);
    if (existing) {
      if (existing.status !== "ready") {
        throw new WorkspaceProjectError(
          "PROJECT_MEMORY_UNVERIFIED",
          "Existing local binding is not verified for Project-only memory."
        );
      }
      await this.openBoundProject(workspaceId);
      return existing;
    }

    const namingMode = input.namingMode ?? "workspace-name";
    const workspaceName =
      input.workspaceName === undefined ? undefined : sanitizeWorkspaceName(input.workspaceName);
    const projectName = projectNameFor({ workspaceId, workspaceName, namingMode });

    const page = await this.rootPage();
    let newProject = await firstVisible(page, NEW_PROJECT_SELECTORS);
    if (!newProject) {
      const byText = page.getByRole("button", { name: /new project|새 프로젝트/i }).first();
      if (await byText.isVisible().catch(() => false)) newProject = byText;
    }
    if (!newProject) {
      throw new WorkspaceProjectError(
        "PROJECT_CREATE_UNAVAILABLE",
        "Could not find ChatGPT's New project control."
      );
    }

    await newProject.click();
    await page.waitForTimeout(200);
    let dialog = await projectDialog(page);

    let nameInput = await firstVisible(dialog, PROJECT_NAME_INPUT_SELECTORS);
    if (!nameInput) {
      const textboxes = dialog.getByRole("textbox");
      const count = await textboxes.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const box = textboxes.nth(i);
        if (await box.isVisible().catch(() => false)) {
          nameInput = box;
          break;
        }
      }
    }
    if (!nameInput) {
      throw new WorkspaceProjectError(
        "PROJECT_CREATE_FAILED",
        "New-project UI opened but no visible project-name input was found."
      );
    }

    await nameInput.fill(projectName);
    await selectProjectOnlyMemory(page, dialog);

    dialog = await projectDialog(page);
    let create = dialog.getByRole("button", { name: CREATE_PROJECT_LABEL }).last();
    if (!(await create.isVisible().catch(() => false))) {
      create = dialog.locator('button[type="submit"]').last();
    }
    if (await create.isVisible().catch(() => false)) {
      if (!(await create.isEnabled().catch(() => false))) {
        throw new WorkspaceProjectError("PROJECT_CREATE_FAILED", "Project create button is disabled.");
      }
      await create.click();
    } else {
      await nameInput.press("Enter");
    }

    const deadline = Date.now() + 15_000;
    let projectId: string | null = null;
    while (Date.now() < deadline) {
      projectId = extractProjectId(page.url());
      if (projectId) break;
      await page.waitForTimeout(250);
    }
    if (!projectId || !isValidProjectId(projectId)) {
      throw new WorkspaceProjectError(
        "PROJECT_CREATE_FAILED",
        "Project creation did not land on a verifiable ChatGPT Project URL."
      );
    }

    const now = new Date().toISOString();
    const binding: WorkspaceProjectBinding = {
      workspaceId,
      workspaceName: workspaceName ?? null,
      namingMode,
      projectId,
      projectName,
      projectUrl: projectHomeUrl(projectId),
      memoryMode: "project-only",
      memoryVerifiedAt: now,
      memoryVerificationSource: "creation",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsert(binding);
    return binding;
  }
}
