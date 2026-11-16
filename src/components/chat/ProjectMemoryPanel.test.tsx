import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ProjectMemoryPanel, MemoryEditor } from "./ProjectMemoryPanel";
import { MemorySaveButton } from "./MemorySaveButton";
import { memoryDraft, type MemorySnapshot } from "../../app/projectMemory";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
class HostNode {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: HostNode[] = [];
  parentNode: HostNode | null = null;
  style = {};
  attributes: Record<string, string> = {};
  value = "";
  defaultValue = "";
  ownerDocument: Record<string, unknown>;
  private text = "";
  constructor(
    readonly tagName: string,
    document: Record<string, unknown>,
  ) {
    this.ownerDocument = document;
  }
  get options() {
    return this.childNodes
      .flatMap(allNodes)
      .filter((node) => node.tagName === "OPTION");
  }
  get nodeName() {
    return this.tagName;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    return (
      this.text + this.childNodes.map((child) => child.textContent).join("")
    );
  }
  set textContent(value: string) {
    this.text = value;
    this.childNodes = [];
  }
  appendChild(child: HostNode) {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: HostNode) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }
  insertBefore(child: HostNode, before: HostNode) {
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  setAttributeNS(_namespace: string, name: string, value: string) {
    this.setAttribute(name, value);
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}

function allNodes(node: HostNode): HostNode[] {
  return [node, ...node.childNodes.flatMap(allNodes)];
}

function onClick(node: HostNode): () => void {
  const key = Object.keys(node).find((name) =>
    name.startsWith("__reactProps$"),
  )!;
  return (node as unknown as Record<string, { onClick: () => void }>)[key]
    .onClick;
}

function installHostDom() {
  const document: Record<string, unknown> = {
    nodeType: 9,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };
  document.createElement = (name: string) =>
    new HostNode(name.toUpperCase(), document);
  document.createElementNS = (_namespace: string, name: string) =>
    new HostNode(name.toUpperCase(), document);
  document.createTextNode = (text: string) => {
    const node = new HostNode("#text", document);
    node.nodeType = 3;
    node.textContent = text;
    return node;
  };
  const container = new HostNode("DIV", document);
  document.body = container;
  document.documentElement = container;
  const window = {
    document,
    HTMLIFrameElement: class {},
    addEventListener() {},
    removeEventListener() {},
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    dispatchEvent: vi.fn(),
  };
  document.defaultView = window;
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", HostNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return container;
}

function props(node: HostNode): Record<string, (event: unknown) => void> {
  const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"))!;
  return (
    node as unknown as Record<string, Record<string, (event: unknown) => void>>
  )[key];
}
function openPanel(container: HostNode) {
  const node = allNodes(container).find((node) => node.tagName === "DETAILS")!;
  props(node).onToggle({
    target: node,
    currentTarget: Object.assign(node, { open: true }),
  });
}
const snapshot = (): MemorySnapshot => ({
  projectDirectory: "/synthetic/project",
  storage: "project",
  revision: "initial",
  entries: [],
  outputBytes: 0,
  maxOutputBytes: 16384,
  warnings: [],
  files: [
    { cli: "Codex", fileName: "AGENTS.md", state: "synced", reason: null },
  ],
});
afterEach(() => {
  vi.unstubAllGlobals();
  invoke.mockReset();
});
it("keeps source imports lazy and exposes scoped editable fields without native reads", () => {
  const html = renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <ProjectMemoryPanel
        directory="/synthetic/project"
        definitionId="codex"
        configDirectory={null}
      />
    </I18nProvider>,
  );
  expect(html).toContain("跨工具記憶庫");
  expect(invoke).not.toHaveBeenCalled();
  const editor = renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <MemoryEditor
        value={memoryDraft("", "a decision")}
        onChange={() => {}}
        disabled={false}
        directory=""
      />
    </I18nProvider>,
  );
  expect(editor).toContain('<option value="project" disabled="">');
  expect(editor).toContain("跨專案");
  expect(editor).toContain("a decision");
});
it("requires a separate confirmation before adding the gitignore entry", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  invoke.mockResolvedValue(snapshot());
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <ProjectMemoryPanel
            directory="/synthetic/project"
            definitionId="codex"
            configDirectory={null}
          />
        </I18nProvider>,
      ),
    );
    await act(async () => openPanel(container));
    expect(invoke).toHaveBeenCalledWith("project_memory_inspect", {
      projectDirectory: "/synthetic/project",
    });
    const button = (text: string) =>
      allNodes(container).find(
        (node) => node.tagName === "BUTTON" && node.textContent === text,
      )!;
    await act(async () => onClick(button("將記憶目錄加入 .gitignore…"))());
    expect(container.textContent).toContain("是否在此專案");
    expect(
      invoke.mock.calls.filter((call) => call[0] === "project_memory_mutate"),
    ).toHaveLength(0);
    await act(async () => onClick(button("取消"))());
    expect(
      invoke.mock.calls.filter((call) => call[0] === "project_memory_mutate"),
    ).toHaveLength(0);
    await act(async () => onClick(button("將記憶目錄加入 .gitignore…"))());
    await act(async () => onClick(button("確認新增"))());
    expect(invoke).toHaveBeenCalledWith("project_memory_mutate", {
      projectDirectory: "/synthetic/project",
      expectedRevision: "initial",
      action: { kind: "ignore", confirmed: true },
    });
  } finally {
    await act(async () => root.unmount());
  }
});
it("imports only individually selected safe candidates and cancelling writes nothing", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const source = {
    kind: "cli",
    cli: "codex",
    conversationId: null,
    path: "/synthetic/MEMORY.md",
  };
  invoke.mockImplementation(async (command) =>
    command === "project_memory_import"
      ? {
          revision: "preview",
          warnings: [],
          candidates: [
            {
              id: "safe",
              kind: "project",
              content: "Use fixtures",
              source,
              blocked: false,
            },
            {
              id: "secret",
              kind: "project",
              content: "[REDACTED]",
              source,
              blocked: true,
            },
          ],
        }
      : snapshot(),
  );
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <ProjectMemoryPanel
            directory="/synthetic/project"
            definitionId="codex"
            configDirectory="/synthetic/codex"
          />
        </I18nProvider>,
      ),
    );
    await act(async () => openPanel(container));
    const button = (text: string) =>
      allNodes(container).find(
        (node) => node.tagName === "BUTTON" && node.textContent === text,
      )!;
    await act(async () => onClick(button("讀取候選條目"))());
    expect(invoke).toHaveBeenCalledWith("project_memory_import", {
      projectDirectory: "/synthetic/project",
      definitionId: "codex",
      configDirectory: "/synthetic/codex",
    });
    const checks = () =>
      allNodes(container).filter((node) => node.tagName === "INPUT");
    expect(checks()[1].attributes.disabled).toBeDefined();
    await act(async () => onClick(button("取消"))());
    expect(
      invoke.mock.calls.filter((call) => call[0] === "project_memory_mutate"),
    ).toHaveLength(0);
    await act(async () => onClick(button("讀取候選條目"))());
    await act(async () =>
      props(checks()[0]).onChange({ target: { checked: true } }),
    );
    await act(async () => onClick(button("確認匯入 1 條"))());
    expect(invoke).toHaveBeenCalledWith("project_memory_mutate", {
      projectDirectory: "/synthetic/project",
      expectedRevision: "initial",
      action: {
        kind: "import",
        ids: ["safe"],
        scope: "project",
        definitionId: "codex",
        configDirectory: "/synthetic/codex",
        previewRevision: "preview",
      },
    });
  } finally {
    await act(async () => root.unmount());
  }
});
it("edits pins and deletes with the current revision and displays source and sync state", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const saved = {
    ...snapshot(),
    entries: [
      {
        ...memoryDraft("/synthetic/project", "Use fixtures"),
        id: "entry",
        blocked: false,
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 0,
      },
    ],
  };
  invoke.mockResolvedValue(saved);
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <ProjectMemoryPanel
            directory="/synthetic/project"
            definitionId="codex"
            configDirectory={null}
          />
        </I18nProvider>,
      ),
    );
    await act(async () => openPanel(container));
    const button = (text: string) =>
      allNodes(container).find(
        (node) => node.tagName === "BUTTON" && node.textContent === text,
      )!;
    expect(container.textContent).toContain("已同步");
    expect(container.textContent).toContain("手動");
    await act(async () => onClick(button("釘選"))());
    expect(invoke).toHaveBeenCalledWith(
      "project_memory_mutate",
      expect.objectContaining({
        action: {
          kind: "upsert",
          draft: expect.objectContaining({ id: "entry", pinned: true }),
        },
      }),
    );
    await act(async () => onClick(button("編輯"))());
    const area = allNodes(container).find(
      (node) => node.tagName === "TEXTAREA",
    )!;
    await act(async () =>
      props(area).onChange({ target: { value: "Revised" } }),
    );
    await act(async () =>
      props(
        allNodes(container).find((node) => node.tagName === "FORM")!,
      ).onSubmit({ preventDefault() {} }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "project_memory_mutate",
      expect.objectContaining({
        action: {
          kind: "upsert",
          draft: expect.objectContaining({ content: "Revised" }),
        },
      }),
    );
    await act(async () => onClick(button("刪除記憶"))());
    expect(invoke).toHaveBeenCalledWith(
      "project_memory_mutate",
      expect.objectContaining({
        action: { kind: "delete", id: "entry", scope: "project" },
      }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
it("opens a message editor with redacted text and writes only after confirmation", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  invoke.mockResolvedValue(snapshot());
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <MemorySaveButton
            text="Use fixtures; token=FAKE_SECRET"
            directory="/synthetic/project"
            cli="codex"
            conversationId="fake-turn"
          />
        </I18nProvider>,
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
    await act(async () =>
      onClick(allNodes(container).find((node) => node.tagName === "BUTTON")!)(),
    );
    expect(container.textContent).not.toContain("FAKE_SECRET");
    const area = allNodes(container).find(
      (node) => node.tagName === "TEXTAREA",
    )!;
    expect(area.value).toContain("[REDACTED]");
    const save = () =>
      allNodes(container).find(
        (node) => node.tagName === "BUTTON" && node.textContent === "儲存",
      )!;
    expect(save().attributes.disabled).toBeDefined();
    await act(async () =>
      props(area).onChange({ target: { value: "Use fixtures" } }),
    );
    await act(async () =>
      props(
        allNodes(container).find((node) => node.tagName === "FORM")!,
      ).onSubmit({ preventDefault() {} }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "project_memory_mutate",
      expect.objectContaining({
        action: {
          kind: "upsert",
          draft: expect.objectContaining({
            content: "Use fixtures",
            source: {
              kind: "conversation",
              cli: "codex",
              conversationId: "fake-turn",
              path: null,
            },
          }),
        },
      }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
it("retains a saved message and warns instead of claiming success when sync is pending", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  invoke.mockImplementation(async (command) =>
    command === "project_memory_mutate"
      ? { ...snapshot(), warnings: ["memory.outputLimit"] }
      : snapshot(),
  );
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <MemorySaveButton
            text="A long term decision"
            directory="/synthetic/project"
          />
        </I18nProvider>,
      ),
    );
    await act(async () =>
      onClick(allNodes(container).find((node) => node.tagName === "BUTTON")!)(),
    );
    const submit = () =>
      props(
        allNodes(container).find((node) => node.tagName === "FORM")!,
      ).onSubmit({ preventDefault() {} });
    await act(async () => submit());
    expect(container.textContent).toContain("條目已儲存，但指示檔尚未同步");
    expect(
      allNodes(container).find(
        (node) => node.tagName === "BUTTON" && node.textContent === "儲存",
      )!.attributes.disabled,
    ).toBeDefined();
    await act(async () => submit());
    expect(
      invoke.mock.calls.filter((call) => call[0] === "project_memory_mutate"),
    ).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
  }
});
