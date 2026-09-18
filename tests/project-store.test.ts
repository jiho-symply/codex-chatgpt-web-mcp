import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceProjectStore,
  WorkspaceProjectStoreError,
  projectNameFor,
  sanitizeWorkspaceName,
  validateWorkspaceId,
} from "../src/projects/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-projects-"));
  dirs.push(dir);
  return dir;
}

describe("workspace project store", () => {
  it("accepts only opaque workspace fingerprints", () => {
    expect(validateWorkspaceId("ws_0123456789abcdef")).toBe("ws_0123456789abcdef");
    expect(() => validateWorkspaceId("/home/user/repo")).toThrowError(WorkspaceProjectStoreError);
    expect(() => validateWorkspaceId("https://github.com/org/repo")).toThrowError(
      WorkspaceProjectStoreError
    );
    expect(() => validateWorkspaceId("repo-name")).toThrowError(WorkspaceProjectStoreError);
  });

  it("generates unique human-readable or anonymous project names", () => {
    const workspaceId = "ws_0123456789abcdef01234567";
    expect(
      projectNameFor({
        workspaceId,
        workspaceName: "vm-placement",
        namingMode: "workspace-name",
      })
    ).toBe("CGW-vm-placement · 012345");
    expect(
      projectNameFor({
        workspaceId,
        namingMode: "anonymous",
      })
    ).toBe("CGW-Workspace 0123456789ab");
  });

  it("rejects paths and URLs as display names", () => {
    expect(() => sanitizeWorkspaceName("/home/user/repo")).toThrowError(
      WorkspaceProjectStoreError
    );
    expect(() => sanitizeWorkspaceName("https://example.com/repo")).toThrowError(
      WorkspaceProjectStoreError
    );
  });

  it("persists exact workspace-to-project bindings without project-name lookup", () => {
    const dir = tmp();
    const store = new WorkspaceProjectStore(dir);
    const now = new Date().toISOString();
    const binding = {
      workspaceId: "ws_0123456789abcdef01234567",
      workspaceName: "demo",
      namingMode: "workspace-name" as const,
      projectId: "g-p-6aa23c9208608191a9b5403be2098710",
      projectName: "CGW-demo · 012345",
      projectUrl: "https://chatgpt.com/g/g-p-6aa23c9208608191a9b5403be2098710/project",
      memoryMode: "project-only" as const,
      memoryVerifiedAt: now,
      memoryVerificationSource: "creation" as const,
      status: "ready" as const,
      createdAt: now,
      updatedAt: now,
    };

    store.upsert(binding);
    expect(store.get(binding.workspaceId)).toEqual(binding);
    expect(store.list()).toEqual([binding]);

    const raw = fs.readFileSync(
      path.join(dir, "projects", "workspace-projects.json"),
      "utf8"
    );
    expect(raw).toContain(binding.projectId);
    expect(raw).not.toContain("/home/");
  });

  it("unbinds only the local record", () => {
    const store = new WorkspaceProjectStore(tmp());
    const now = new Date().toISOString();
    const binding = {
      workspaceId: "ws_abcdef0123456789abcdef01",
      workspaceName: null,
      namingMode: "anonymous" as const,
      projectId: "g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      projectName: "CGW-Workspace abcdef012345",
      projectUrl: "https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/project",
      memoryMode: "project-only" as const,
      memoryVerifiedAt: now,
      memoryVerificationSource: "creation" as const,
      status: "ready" as const,
      createdAt: now,
      updatedAt: now,
    };
    store.upsert(binding);
    expect(store.remove(binding.workspaceId)).toBe(true);
    expect(store.find(binding.workspaceId)).toBeNull();
  });
});
