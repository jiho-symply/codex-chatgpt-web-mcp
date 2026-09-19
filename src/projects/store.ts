import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ensurePrivateDir } from "../config.js";

export const PROJECT_NAME_PREFIX = "CGW-";
export type ProjectNamingMode = "workspace-name" | "anonymous";
export type WorkspaceProjectStatus = "ready" | "memory_unverified";

export interface WorkspaceProjectBinding {
  workspaceId: string;
  workspaceName: string | null;
  namingMode: ProjectNamingMode;
  projectId: string;
  projectName: string;
  projectUrl: string;
  memoryMode: "project-only";
  memoryVerifiedAt: string | null;
  memoryVerificationSource: "creation" | "settings" | null;
  status: WorkspaceProjectStatus;
  createdAt: string;
  updatedAt: string;
}

interface ProjectState {
  version: 1;
  bindings: WorkspaceProjectBinding[];
}

export class WorkspaceProjectStoreError extends Error {
  constructor(
    public readonly code:
      | "WORKSPACE_ID_INVALID"
      | "WORKSPACE_NOT_BOUND"
      | "PROJECT_STATE_CORRUPT",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceProjectStoreError";
  }
}

function projectDir(stateDir: string): string {
  return ensurePrivateDir(path.join(stateDir, "projects"));
}

function stateFile(stateDir: string): string {
  return path.join(projectDir(stateDir), "workspace-projects.json");
}

function readState(stateDir: string): ProjectState {
  const file = stateFile(stateDir);
  if (!fs.existsSync(file)) return { version: 1, bindings: [] };
  if (fs.lstatSync(file).isSymbolicLink()) {
    throw new WorkspaceProjectStoreError("PROJECT_STATE_CORRUPT", "Refusing symlinked project-state file.");
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProjectState>;
    if (raw.version !== 1 || !Array.isArray(raw.bindings)) throw new Error("invalid shape");
    return { version: 1, bindings: raw.bindings as WorkspaceProjectBinding[] };
  } catch (error) {
    if (error instanceof WorkspaceProjectStoreError) throw error;
    throw new WorkspaceProjectStoreError(
      "PROJECT_STATE_CORRUPT",
      "Workspace/project binding state is unreadable or invalid."
    );
  }
}

function writeState(stateDir: string, state: ProjectState): void {
  const file = stateFile(stateDir);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new WorkspaceProjectStoreError("PROJECT_STATE_CORRUPT", "Refusing symlinked project-state file.");
  }
  const temp = file + "." + randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function validateWorkspaceId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^ws_[a-f0-9]{12,64}$/.test(normalized)) {
    throw new WorkspaceProjectStoreError(
      "WORKSPACE_ID_INVALID",
      "workspace_id must be an opaque local fingerprint in the form ws_<12-64 hex>. Do not pass a path or remote URL."
    );
  }
  return normalized;
}

export function sanitizeWorkspaceName(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 80) {
    throw new WorkspaceProjectStoreError(
      "WORKSPACE_ID_INVALID",
      "workspace_name must be 1-80 visible characters."
    );
  }
  if (/https?:\/\//i.test(normalized) || normalized.includes("/") || normalized.includes("\\")) {
    throw new WorkspaceProjectStoreError(
      "WORKSPACE_ID_INVALID",
      "workspace_name must be a display name only, not a path or URL."
    );
  }
  return normalized;
}

export function projectNameFor(input: {
  workspaceId: string;
  workspaceName?: string;
  namingMode: ProjectNamingMode;
}): string {
  const workspaceId = validateWorkspaceId(input.workspaceId);
  const short = workspaceId.slice(3, 15);
  if (input.namingMode === "anonymous") return PROJECT_NAME_PREFIX + "Workspace " + short;
  if (!input.workspaceName) {
    throw new WorkspaceProjectStoreError(
      "WORKSPACE_ID_INVALID",
      "workspace_name is required when naming_mode=workspace-name."
    );
  }
  const name = sanitizeWorkspaceName(input.workspaceName);
  return PROJECT_NAME_PREFIX + name + " · " + short.slice(0, 6);
}

export class WorkspaceProjectStore {
  constructor(private readonly stateDir: string) {}

  get(workspaceId: string): WorkspaceProjectBinding {
    const id = validateWorkspaceId(workspaceId);
    const record = readState(this.stateDir).bindings.find((item) => item.workspaceId === id);
    if (!record) {
      throw new WorkspaceProjectStoreError("WORKSPACE_NOT_BOUND", "Workspace is not bound to a ChatGPT Project: " + id);
    }
    return record;
  }

  find(workspaceId: string): WorkspaceProjectBinding | null {
    const id = validateWorkspaceId(workspaceId);
    return readState(this.stateDir).bindings.find((item) => item.workspaceId === id) ?? null;
  }

  list(): WorkspaceProjectBinding[] {
    return readState(this.stateDir).bindings;
  }

  upsert(binding: WorkspaceProjectBinding): WorkspaceProjectBinding {
    const state = readState(this.stateDir);
    const index = state.bindings.findIndex((item) => item.workspaceId === binding.workspaceId);
    if (index >= 0) state.bindings[index] = binding;
    else state.bindings.push(binding);
    writeState(this.stateDir, state);
    return binding;
  }

  remove(workspaceId: string): boolean {
    const id = validateWorkspaceId(workspaceId);
    const state = readState(this.stateDir);
    const index = state.bindings.findIndex((item) => item.workspaceId === id);
    if (index < 0) return false;
    state.bindings.splice(index, 1);
    writeState(this.stateDir, state);
    return true;
  }
}
