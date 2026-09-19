import type { Locator, Page } from "playwright";
import { CHATGPT_ORIGIN, type AppConfig } from "../config.js";
import { BrowserRuntime } from "../browser/runtime.js";
import {
  extractProjectId,
  isValidProjectId,
  projectHomeUrl,
  PROMPT_SELECTORS,
} from "../browser/selectors.js";
import {
  WorkspaceProjectStore,
  projectNameFor,
  sanitizeWorkspaceName,
  validateWorkspaceId,
  type ProjectNamingMode,
  type WorkspaceProjectBinding,
} from "./store.js";

export type WorkspaceProjectErrorCode =
  | "WORKSPACE_REQUIRED"
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

const PROJECT_ONLY_LABEL =
  /project[- ]only memory|project only|프로젝트 전용 메모리|프로젝트만/i;
const MORE_OPTIONS_LABEL = /more options|advanced|추가 옵션|고급/i;
const CREATE_PROJECT_LABEL =
  /create project|create|프로젝트 만들기|프로젝트 생성|생성/i;
const PROJECT_SETTINGS_LABEL = /project settings|프로젝트 설정/i;
const PROJECT_OPTIONS_LABEL =
  /project options|project menu|more options|more|프로젝트 옵션|프로젝트 메뉴|더보기/i;
const SAVE_LABEL = /^(save|저장)$/i;
const PROJECTS_SECTION_LABEL = /^(projects|프로젝트)$/i;
const OPEN_SIDEBAR_LABEL =
  /open sidebar|show sidebar|사이드바 열기|사이드바 표시/i;

async function firstVisible(
  scope: Page | Locator,
  selectors: readonly string[]
): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function visibleComposer(page: Page): Promise<Locator | null> {
  return firstVisible(page, PROMPT_SELECTORS);
}

async function waitForProjectCreationScope(
  page: Page,
  timeoutMs = 5_000
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dialog = page.getByRole("dialog").last();
    if (await dialog.isVisible().catch(() => false)) return dialog;

    const nameInput = await firstVisible(page, PROJECT_NAME_INPUT_SELECTORS);
    if (nameInput) {
      for (const xpath of [
        "xpath=ancestor::form[1]",
        "xpath=ancestor::*[@role='dialog'][1]",
        "xpath=ancestor::*[@data-radix-popper-content-wrapper][1]",
      ]) {
        const scope = nameInput.locator(xpath);
        if ((await scope.count().catch(() => 0)) > 0) return scope.first();
      }
    }
    await page.waitForTimeout(100);
  }
  throw new WorkspaceProjectError(
    "PROJECT_CREATE_FAILED",
    "New Project UI did not expose a scoped creation surface."
  );
}

async function visibleProjectOnly(scope: Locator): Promise<Locator | null> {
  for (const role of ["radio", "option", "menuitem"] as const) {
    const item = scope.getByRole(role, { name: PROJECT_ONLY_LABEL }).first();
    if (await item.isVisible().catch(() => false)) return item;
  }
  const text = scope.getByText(PROJECT_ONLY_LABEL).first();
  return (await text.isVisible().catch(() => false)) ? text : null;
}

async function activeChoiceOverlay(page: Page): Promise<Locator | null> {
  for (const selector of ['[role="listbox"]:visible', '[role="menu"]:visible']) {
    const overlay = page.locator(selector).last();
    if (await overlay.isVisible().catch(() => false)) return overlay;
  }
  return null;
}

async function selectionLooksProjectOnly(scope: Locator): Promise<boolean> {
  const radio = scope.getByRole("radio", { name: PROJECT_ONLY_LABEL }).first();
  if (await radio.isVisible().catch(() => false)) {
    if (await radio.isChecked().catch(() => false)) return true;
    if ((await radio.getAttribute("aria-checked").catch(() => null)) === "true") return true;
  }

  const selected = scope.locator(
    '[aria-checked="true"], [aria-selected="true"], [data-state="checked"], [data-state="active"]'
  );
  const selectedCount = await selected.count().catch(() => 0);
  for (let i = 0; i < selectedCount; i++) {
    const item = selected.nth(i);
    const text = (await item.innerText().catch(() => "")).trim();
    const aria = (await item.getAttribute("aria-label").catch(() => null)) ?? "";
    if (PROJECT_ONLY_LABEL.test(text) || PROJECT_ONLY_LABEL.test(aria)) return true;
  }

  for (const selector of ['[role="combobox"]', 'button[aria-haspopup="listbox"]']) {
    const controls = scope.locator(selector);
    const count = await controls.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const control = controls.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;
      const text = (await control.innerText().catch(() => "")).trim();
      const aria = (await control.getAttribute("aria-label").catch(() => null)) ?? "";
      if (PROJECT_ONLY_LABEL.test(text) || PROJECT_ONLY_LABEL.test(aria)) return true;
    }
  }
  return false;
}

async function selectProjectOnlyMemory(page: Page, dialog: Locator): Promise<void> {
  let option = await visibleProjectOnly(dialog);

  if (!option) {
    const more = dialog.getByRole("button", { name: MORE_OPTIONS_LABEL }).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      await page.waitForTimeout(150);
      option = await visibleProjectOnly(dialog);
    }
  }

  if (!option) {
    const memoryButton = dialog.getByRole("button", { name: /memory|메모리/i }).first();
    const memoryCombo = dialog.getByRole("combobox", { name: /memory|메모리/i }).first();
    const control = (await memoryButton.isVisible().catch(() => false))
      ? memoryButton
      : (await memoryCombo.isVisible().catch(() => false))
        ? memoryCombo
        : null;

    if (control) {
      await control.click();
      await page.waitForTimeout(150);
      const overlay = await activeChoiceOverlay(page);
      if (overlay) option = await visibleProjectOnly(overlay);
    }
  }

  if (!option) {
    throw new WorkspaceProjectError(
      "PROJECT_MEMORY_UNAVAILABLE",
      "The New Project dialog did not expose Project-only memory."
    );
  }

  await option.click();
  await page.waitForTimeout(150);

  if (!(await selectionLooksProjectOnly(dialog))) {
    const overlay = await activeChoiceOverlay(page);
    if (!overlay || !(await selectionLooksProjectOnly(overlay))) {
      throw new WorkspaceProjectError(
        "PROJECT_MEMORY_UNVERIFIED",
        "Project-only memory could not be confirmed before Project creation."
      );
    }
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

function explicitComposerProjectName(label: string): string | null {
  const normalized = label.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  for (const pattern of [
    /^new chat in\s+(.+)$/i,
    /^chat in\s+(.+)$/i,
    /^(.+?)\s*(?:프로젝트에서|에서)\s*새 채팅$/i,
  ]) {
    const match = normalized.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

function sameDisplayName(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim().toLocaleLowerCase() ===
    b.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}


async function findNewProjectControl(page: Page): Promise<Locator | null> {
  const exact = await firstVisible(page, NEW_PROJECT_SELECTORS);
  if (exact) return exact;

  const controls = page.locator('button,[role="button"]');
  const count = await controls.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    const label = [
      await control.innerText().catch(() => ""),
      (await control.getAttribute("aria-label").catch(() => null)) ?? "",
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (/new project|새 프로젝트/i.test(label)) return control;
  }
  return null;
}

async function maybeOpenSidebar(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: OPEN_SIDEBAR_LABEL }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click().catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

async function maybeExpandProjectsSection(page: Page): Promise<boolean> {
  const candidates = page.getByText(PROJECTS_SECTION_LABEL, { exact: true });
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const text = candidates.nth(i);
    if (!(await text.isVisible().catch(() => false))) continue;

    const button = text.locator("xpath=ancestor-or-self::button[1]");
    if ((await button.count().catch(() => 0)) > 0) {
      const expanded = await button.getAttribute("aria-expanded").catch(() => null);
      if (expanded === "false") {
        await button.click().catch(() => undefined);
        await page.waitForTimeout(150);
      }
      return true;
    }

    const row = text.locator(
      "xpath=ancestor::*[@role='button' or @role='treeitem' or @role='listitem'][1]"
    );
    if ((await row.count().catch(() => 0)) > 0) {
      const expanded = await row.getAttribute("aria-expanded").catch(() => null);
      if (expanded === "false") {
        await row.click().catch(() => undefined);
        await page.waitForTimeout(150);
      }
      return true;
    }

    return true;
  }
  return false;
}

async function waitForNewProjectControl(
  page: Page,
  timeoutMs = 8_000
): Promise<{ control: Locator | null; projectsSectionSeen: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let projectsSectionSeen = false;
  let prepared = false;

  while (Date.now() < deadline) {
    const control = await findNewProjectControl(page);
    if (control) return { control, projectsSectionSeen };

    if (!prepared) {
      await maybeOpenSidebar(page);
      prepared = true;
    }

    projectsSectionSeen =
      (await maybeExpandProjectsSection(page)) || projectsSectionSeen;

    const afterExpand = await findNewProjectControl(page);
    if (afterExpand) return { control: afterExpand, projectsSectionSeen };

    await page.waitForTimeout(250);
  }

  return { control: null, projectsSectionSeen };
}

async function waitForProjectNameInput(
  page: Page,
  visibleBefore: number,
  timeoutMs = 5_000
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const named = await firstVisible(page, PROJECT_NAME_INPUT_SELECTORS);
    if (named) return named;

    const textInputs = page.locator('input[type="text"]:visible');
    const count = await textInputs.count().catch(() => 0);
    if (count > visibleBefore) return textInputs.last();

    await page.waitForTimeout(100);
  }
  throw new WorkspaceProjectError(
    "PROJECT_CREATE_FAILED",
    "New Project popover did not expose a visible project-name input."
  );
}

async function projectRowForId(
  page: Page,
  projectId: string,
  projectName: string
): Promise<Locator | null> {
  const links = page.locator('a[href*="/g/g-p-"]');
  const count = await links.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = await link.getAttribute("href").catch(() => null);
    if (canonicalProjectIdFromHref(href) !== projectId) continue;
    for (const xpath of [
      "xpath=ancestor::*[self::li or @role='treeitem' or @role='listitem' or @data-sidebar-item='true'][1]",
      "xpath=..",
    ]) {
      const row = link.locator(xpath);
      if ((await row.count().catch(() => 0)) > 0) return row.first();
    }
    return link;
  }

  const exactName = page.getByText(projectName, { exact: true });
  const nameCount = await exactName.count().catch(() => 0);
  for (let i = 0; i < nameCount; i++) {
    const node = exactName.nth(i);
    if (!(await node.isVisible().catch(() => false))) continue;
    for (const xpath of [
      "xpath=ancestor::*[self::li or @role='treeitem' or @role='listitem' or @data-sidebar-item='true'][1]",
      "xpath=..",
    ]) {
      const row = node.locator(xpath);
      if ((await row.count().catch(() => 0)) > 0) return row.first();
    }
  }
  return null;
}

async function waitForProjectSettingsScope(
  page: Page,
  timeoutMs = 5_000
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dialogs = page.getByRole("dialog");
    const count = await dialogs.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const dialog = dialogs.nth(i);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const text = await dialog.innerText().catch(() => "");
      if (/project settings|프로젝트 설정|memory|메모리/i.test(text)) return dialog;
    }

    const heading = page.getByText(PROJECT_SETTINGS_LABEL).last();
    if (await heading.isVisible().catch(() => false)) {
      for (const xpath of [
        "xpath=ancestor::*[@role='dialog'][1]",
        "xpath=ancestor::form[1]",
        "xpath=ancestor::main[1]",
      ]) {
        const scope = heading.locator(xpath);
        if ((await scope.count().catch(() => 0)) > 0) return scope.first();
      }
    }
    await page.waitForTimeout(100);
  }
  throw new WorkspaceProjectError(
    "PROJECT_MEMORY_UNAVAILABLE",
    "Project settings did not expose a usable settings surface."
  );
}

async function openProjectSettings(
  page: Page,
  projectId: string,
  projectName: string
): Promise<Locator> {
  const direct = page.getByRole("button", { name: PROJECT_SETTINGS_LABEL }).first();
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    return waitForProjectSettingsScope(page);
  }

  let menuButton: Locator | null = null;
  const row = await projectRowForId(page, projectId, projectName);
  if (row) {
    for (const selector of [
      'button[aria-haspopup="menu"]',
      "button[data-trailing-button]",
      'button[aria-label*="more" i]',
      'button[aria-label*="더보기"]',
    ]) {
      const candidates = row.locator(selector);
      const count = await candidates.count().catch(() => 0);
      for (let i = count - 1; i >= 0; i--) {
        const candidate = candidates.nth(i);
        if (await candidate.isVisible().catch(() => false)) {
          menuButton = candidate;
          break;
        }
      }
      if (menuButton) break;
    }
  }

  if (!menuButton) {
    const buttons = page.getByRole("button");
    const count = await buttons.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      const label =
        ((await button.getAttribute("aria-label").catch(() => null)) ?? "") +
        " " +
        (await button.innerText().catch(() => ""));
      if (PROJECT_OPTIONS_LABEL.test(label)) {
        menuButton = button;
        break;
      }
    }
  }

  if (!menuButton) {
    throw new WorkspaceProjectError(
      "PROJECT_MEMORY_UNAVAILABLE",
      "Could not find the current Project's options menu."
    );
  }

  await menuButton.click();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    for (const role of ["menuitem", "button"] as const) {
      const settings = page.getByRole(role, { name: PROJECT_SETTINGS_LABEL }).last();
      if (await settings.isVisible().catch(() => false)) {
        await settings.click();
        return waitForProjectSettingsScope(page);
      }
    }
    const text = page.getByText(PROJECT_SETTINGS_LABEL).last();
    if (await text.isVisible().catch(() => false)) {
      await text.click();
      return waitForProjectSettingsScope(page);
    }
    await page.waitForTimeout(100);
  }

  throw new WorkspaceProjectError(
    "PROJECT_MEMORY_UNAVAILABLE",
    "The Project options menu did not expose Project settings."
  );
}

async function configureProjectOnlyMemoryFromSettings(
  page: Page,
  projectId: string,
  projectName: string
): Promise<void> {
  const settings = await openProjectSettings(page, projectId, projectName);
  await selectProjectOnlyMemory(page, settings);

  if (!(await selectionLooksProjectOnly(settings))) {
    throw new WorkspaceProjectError(
      "PROJECT_MEMORY_UNVERIFIED",
      "Project-only memory was selected but could not be verified in Project settings."
    );
  }

  const save = settings.getByRole("button", { name: SAVE_LABEL }).last();
  if (!(await save.isVisible().catch(() => false))) {
    throw new WorkspaceProjectError(
      "PROJECT_MEMORY_UNVERIFIED",
      "Project settings did not expose a Save action after selecting Project-only memory."
    );
  }
  if (!(await save.isEnabled().catch(() => false))) {
    throw new WorkspaceProjectError(
      "PROJECT_MEMORY_UNVERIFIED",
      "Project settings Save action is disabled after selecting Project-only memory."
    );
  }

  await save.click();
  await page.waitForTimeout(300);
}

export class WorkspaceProjectManager {
  private readonly store: WorkspaceProjectStore;

  constructor(
    private readonly runtime: BrowserRuntime,
    config: AppConfig
  ) {
    this.store = new WorkspaceProjectStore(config.stateDir);
  }

  getBinding(workspaceId: string): WorkspaceProjectBinding {
    return this.store.get(workspaceId);
  }

  listBindings(): WorkspaceProjectBinding[] {
    return this.store.list();
  }

  unbind(workspaceId: string): {
    workspaceId: string;
    unbound: boolean;
    remoteProjectDeleted: false;
  } {
    const id = validateWorkspaceId(workspaceId);
    return {
      workspaceId: id,
      unbound: this.store.remove(id),
      remoteProjectDeleted: false,
    };
  }

  private async rootPage(): Promise<Page> {
    const page = await this.runtime.page();
    await page.goto(CHATGPT_ORIGIN, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    return page;
  }

  private async findSidebarProject(
    page: Page,
    binding: WorkspaceProjectBinding
  ): Promise<Locator | null> {
    const links = page.locator('a[href*="/g/g-p-"]');
    const count = await links.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const link = links.nth(i);
      if (!(await link.isVisible().catch(() => false))) continue;
      const href = await link.getAttribute("href").catch(() => null);
      if (canonicalProjectIdFromHref(href) === binding.projectId) return link;
    }

    // Current UI may render the row as a non-link with a dedicated home button.
    const exactName = page.getByText(binding.projectName, { exact: true }).first();
    if (await exactName.isVisible().catch(() => false)) {
      const row = exactName.locator(
        "xpath=ancestor::*[self::li or @role='treeitem' or @role='listitem'][1]"
      );
      if ((await row.count().catch(() => 0)) > 0) {
        const home = row
          .locator(
            'a[href*="/g/g-p-"], button[aria-label*="project home" i], button[aria-label*="프로젝트 홈"]'
          )
          .first();
        if (await home.isVisible().catch(() => false)) return home;
      }
    }
    return null;
  }

  async assertPageBoundToWorkspace(
    page: Page,
    workspaceId: string
  ): Promise<WorkspaceProjectBinding> {
    const binding = this.store.get(workspaceId);
    if (
      binding.status !== "ready" ||
      binding.memoryMode !== "project-only" ||
      !binding.memoryVerifiedAt
    ) {
      throw new WorkspaceProjectError(
        "PROJECT_MEMORY_UNVERIFIED",
        "Workspace binding was not created with verified Project-only memory."
      );
    }

    if (extractProjectId(page.url()) !== binding.projectId) {
      throw new WorkspaceProjectError(
        "PROJECT_DESTINATION_MISMATCH",
        "The active ChatGPT page is not inside the Project bound to this workspace."
      );
    }

    const composer = await visibleComposer(page);
    if (!composer) {
      throw new WorkspaceProjectError(
        "PROJECT_NAVIGATION_FAILED",
        "The bound Project page does not expose a usable composer."
      );
    }

    const label =
      (await composer.getAttribute("aria-label").catch(() => null)) ??
      (await composer.getAttribute("data-placeholder").catch(() => null)) ??
      "";
    const explicitName = explicitComposerProjectName(label);
    if (explicitName && !sameDisplayName(explicitName, binding.projectName)) {
      throw new WorkspaceProjectError(
        "PROJECT_DESTINATION_MISMATCH",
        "The composer explicitly identifies a different Project."
      );
    }

    return binding;
  }

  async openBoundProject(workspaceId: string): Promise<{
    page: Page;
    binding: WorkspaceProjectBinding;
  }> {
    const binding = this.store.get(workspaceId);
    if (
      binding.status !== "ready" ||
      binding.memoryMode !== "project-only" ||
      !binding.memoryVerifiedAt
    ) {
      throw new WorkspaceProjectError(
        "PROJECT_MEMORY_UNVERIFIED",
        "Workspace binding was not created with verified Project-only memory."
      );
    }

    let page = await this.runtime.page();
    try {
      const current = new URL(page.url());
      if (
        extractProjectId(page.url()) === binding.projectId &&
        /\/project\/?$/.test(current.pathname) &&
        (await visibleComposer(page))
      ) {
        await this.assertPageBoundToWorkspace(page, workspaceId);
        return { page, binding };
      }
    } catch {
      // Navigate from the root below.
    }

    page = await this.rootPage();
    const target = await this.findSidebarProject(page, binding);
    if (!target) {
      throw new WorkspaceProjectError(
        "PROJECT_NOT_FOUND",
        "The exact ChatGPT Project bound to this workspace is not visible in the sidebar."
      );
    }
    await target.click();

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const observed = extractProjectId(page.url());
      if (observed === binding.projectId && (await visibleComposer(page))) {
        await this.assertPageBoundToWorkspace(page, workspaceId);
        return { page, binding };
      }
      if (observed && observed !== binding.projectId) {
        throw new WorkspaceProjectError(
          "PROJECT_DESTINATION_MISMATCH",
          "ChatGPT navigated to a different Project than the workspace binding."
        );
      }
      await page.waitForTimeout(250);
    }

    throw new WorkspaceProjectError(
      "PROJECT_NAVIGATION_FAILED",
      "The sidebar Project navigation did not reach a usable bound Project."
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
      await this.openBoundProject(workspaceId);
      return existing;
    }

    const namingMode = input.namingMode ?? "workspace-name";
    const workspaceName =
      input.workspaceName === undefined
        ? undefined
        : sanitizeWorkspaceName(input.workspaceName);
    const projectName = projectNameFor({
      workspaceId,
      workspaceName,
      namingMode,
    });

    const page = await this.rootPage();
    const discovery = await waitForNewProjectControl(page);
    const newProject = discovery.control;
    if (!newProject) {
      throw new WorkspaceProjectError(
        "PROJECT_CREATE_UNAVAILABLE",
        discovery.projectsSectionSeen
          ? "ChatGPT's Projects section is visible, but the New Project control did not appear after waiting for sidebar hydration."
          : "Could not find ChatGPT's Projects section or New Project control after waiting for sidebar hydration."
      );
    }

    const textInputsBefore = await page
      .locator('input[type="text"]:visible')
      .count()
      .catch(() => 0);
    await newProject.press("Enter").catch(() => newProject.click({ force: true }));

    const nameInput = await waitForProjectNameInput(page, textInputsBefore);
    await nameInput.fill(projectName);
    if ((await nameInput.inputValue().catch(() => "")) !== projectName) {
      throw new WorkspaceProjectError(
        "PROJECT_CREATE_FAILED",
        "Could not confirm the project name before creation."
      );
    }

    await nameInput.press("Enter");

    const deadline = Date.now() + 15_000;
    let projectId: string | null = null;
    while (Date.now() < deadline) {
      projectId = extractProjectId(page.url());
      if (projectId && (await visibleComposer(page))) break;
      await page.waitForTimeout(250);
    }
    if (!projectId || !isValidProjectId(projectId) || !(await visibleComposer(page))) {
      throw new WorkspaceProjectError(
        "PROJECT_CREATE_FAILED",
        "Project creation did not land on a verifiable Project with a usable composer."
      );
    }

    await configureProjectOnlyMemoryFromSettings(page, projectId, projectName);

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
      memoryVerificationSource: "settings",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsert(binding);
    return binding;
  }
}
