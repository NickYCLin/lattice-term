import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { BackgroundHistoryPicker } from "./BackgroundHistoryPicker";
import { MemoryArchiveHistory } from "./MemoryArchiveHistory";
import { MemoryCompactionSettings } from "../settings/MemoryCompactionSettings";
import { ContextDetails } from "./CompactionNotice";
import {
  structureContext,
  type ContextReport,
} from "../../app/memoryCompaction";
const { invoke, history } = vi.hoisted(() => ({
  invoke: vi.fn(),
  history: {
    entries: Array.from({ length: 6 }, (_, i) => ({
      definitionId: ["codex", "claude", "gemini", "qwen", "kimi", "opencode"][
        i
      ],
      nativeSessionId: `fake-${i}`,
      profileId: null,
      title: `Synthetic ${i}`,
      workingDirectory: "/synthetic/project",
    })),
    profileKey: "[]",
    hasMore: false,
    busy: false,
    error: null as string | null,
    loadMore: vi.fn(),
    incomplete: false,
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app/nativeRuntime", () => ({ hasDesktopBackend: () => true }));
vi.mock("../overlays/modalFocus", () => ({ useModalFocus: () => {} }));
vi.mock("../../app/useNativeConversations", () => ({
  useNativeHistory: () => history,
  nativeConversationKey: (entry: { nativeSessionId: string }) =>
    entry.nativeSessionId,
}));
vi.mock("../../app/useChatAccountProfiles", () => ({
  useChatAccountProfiles: () => [
    {
      id: "fake",
      definitionId: "claude",
      name: "Synthetic Claude",
      configDirectory: "/synthetic/claude",
    },
  ],
}));
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
const report: ContextReport = {
  id: "fake-report",
  createdAt: 1,
  label: "Synthetic",
  text: "# 結構化交接摘要\n## 目標\nPublic background",
  originalPath: "/synthetic/archive.json",
  beforeBytes: 40000,
  afterBytes: 1000,
  compacted: true,
  warnings: [],
};
afterEach(() => {
  history.hasMore = false; history.busy = false; history.error = null; history.loadMore.mockReset();
  invoke.mockReset();
  vi.unstubAllGlobals();
});
it("selects at most five supported histories, previews and attaches without sending", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const attach = vi.fn();
  invoke.mockResolvedValue(report);
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <BackgroundHistoryPicker onAttach={attach} />
        </I18nProvider>,
      ),
    );
    await act(async () =>
      onClick(allNodes(container).find((node) => node.tagName === "BUTTON")!)(),
    );
    const checks = () =>
      allNodes(container)
        .filter(
          (node) => node.tagName === "INPUT" && node.attributes.type !== "text",
        )
        .filter(
          (node) =>
            props(node).onChange &&
            node !== allNodes(container).find((n) => n.tagName === "INPUT"),
        );
    // The first input is search; the remaining six are history checkboxes.
    const boxes = () =>
      allNodes(container)
        .filter((node) => node.tagName === "INPUT")
        .slice(1);
    for (let i = 0; i < 5; i++)
      await act(async () =>
        props(boxes()[i]).onChange({ target: { checked: true } }),
      );
    expect(boxes()[5].attributes.disabled).toBeDefined();
    expect(checks().length).toBe(6);
    const button = (text: string) =>
      allNodes(container).find(
        (node) => node.tagName === "BUTTON" && node.textContent === text,
      )!;
    await act(async () => onClick(button("產生摘要預覽"))());
    expect(invoke).toHaveBeenCalledWith("memory_background_context", {
      profiles: [],
      selections: history.entries
        .slice(0, 5)
        .map(({ definitionId, nativeSessionId, profileId }) => ({
          definitionId,
          nativeSessionId,
          profileId,
        })),
    });
    expect(attach).not.toHaveBeenCalled();
    await act(async () => onClick(button("附加背景並開新對話"))());
    expect(attach).toHaveBeenCalledExactlyOnceWith(report);
    expect(
      invoke.mock.calls.some(
        (call) =>
          String(call[0]).includes("send") ||
          String(call[0]).includes("resume"),
      ),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
it("cancels history selection without creating background or changing any source", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const attach = vi.fn();
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <BackgroundHistoryPicker onAttach={attach} />
        </I18nProvider>,
      ),
    );
    await act(async () =>
      onClick(allNodes(container).find((node) => node.tagName === "BUTTON")!)(),
    );
    await act(async () =>
      onClick(
        allNodes(container).find(
          (node) => node.tagName === "BUTTON" && node.textContent === "取消",
        )!,
      )(),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
it("loads and saves backend thresholds with a revision and explicitly selected CLI profile", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const value = {
    preferences: {
      limitBytes: 12288,
      keepVersions: 20,
      staleDays: 90,
      aiEnabled: false,
      cli: "claude",
      configDirectory: null,
    },
    revision: "initial",
  };
  invoke.mockResolvedValue(value);
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <MemoryCompactionSettings />
        </I18nProvider>,
      ),
    );
    expect(invoke).toHaveBeenCalledWith("memory_compaction_settings", {
      preferences: null,
      expectedRevision: null,
    });
    const input = allNodes(container).find((node) => node.tagName === "INPUT")!;
    await act(async () => props(input).onChange({ target: { value: "4096" } }));
    const select = allNodes(container).find(
      (node) => node.tagName === "SELECT",
    )!;
    await act(async () =>
      props(select).onChange({ target: { value: "/synthetic/claude" } }),
    );
    await act(async () =>
      props(
        allNodes(container).find((node) => node.tagName === "FORM")!,
      ).onSubmit({ preventDefault() {} }),
    );
    expect(invoke).toHaveBeenCalledWith("memory_compaction_settings", {
      preferences: {
        ...value.preferences,
        limitBytes: 4096,
        configDirectory: "/synthetic/claude",
      },
      expectedRevision: "initial",
    });
  } finally {
    await act(async () => root.unmount());
  }
});
it("loads version differences and restores only the clicked scope and id", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const restore = vi.fn();
  const version = {
    id: "fake-version",
    scope: "project" as const,
    createdAt: 1,
    reason: "auto" as const,
  };
  invoke.mockResolvedValue({
    beforeText: "Original notes",
    afterText: "Condensed notes",
    warnings: [],
  });
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <MemoryArchiveHistory
            history={[version]}
            directory="/synthetic/project"
            busy={false}
            onRestore={restore}
          />
        </I18nProvider>,
      ),
    );
    const node = allNodes(container).find(
      (node) => node.tagName === "DETAILS",
    )!;
    await act(async () =>
      props(node).onToggle({
        target: node,
        currentTarget: Object.assign(node, { open: true }),
      }),
    );
    expect(invoke).toHaveBeenCalledWith("project_memory_archive", {
      projectDirectory: "/synthetic/project",
      scope: "project",
      id: "fake-version",
    });
    expect(container.textContent).toContain("Original notes");
    expect(container.textContent).toContain("Condensed notes");
    expect(restore).not.toHaveBeenCalled();
    await act(async () =>
      onClick(allNodes(container).find((node) => node.tagName === "BUTTON")!)(),
    );
    expect(restore).toHaveBeenCalledExactlyOnceWith(version);
  } finally {
    await act(async () => root.unmount());
  }
});
it("reads the masked original for comparison and publishes a compression notice", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  invoke.mockResolvedValue([
    {
      role: "assistant",
      kind: "",
      name: "",
      text: "token=FAKE_ORIGINAL_SECRET",
    },
  ]);
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <ContextDetails report={report} />
        </I18nProvider>,
      ),
    );
    await act(async () =>
      onClick(allNodes(container).find((node) => node.tagName === "BUTTON")!)(),
    );
    expect(invoke).toHaveBeenCalledWith("memory_context_original", {
      id: "fake-report",
    });
    expect(container.textContent).toContain("[REDACTED]");
    expect(container.textContent).not.toContain("FAKE_ORIGINAL_SECRET");
    invoke.mockResolvedValue(report);
    expect(await structureContext("fake", "public source")).toEqual(report);
    expect(window.dispatchEvent).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
it("refuses a selection that disappeared during history refresh instead of silently attaching fewer sources", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const attach = vi.fn();
  const original = history.entries.slice();
  try {
    await act(async () =>
      root.render(
        <I18nProvider locale="zh-TW">
          <BackgroundHistoryPicker onAttach={attach} />
        </I18nProvider>,
      ),
    );
    await act(async () =>
      onClick(allNodes(container).find((node) => node.tagName === "BUTTON")!)(),
    );
    const box = allNodes(container).filter(
      (node) => node.tagName === "INPUT",
    )[1];
    await act(async () => props(box).onChange({ target: { checked: true } }));
    history.entries = history.entries.slice(1);
    await act(async () =>
      onClick(
        allNodes(container).find(
          (node) =>
            node.tagName === "BUTTON" && node.textContent === "產生摘要預覽",
        )!,
      )(),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(container.textContent).toContain("無法安全讀取選定的歷史");
  } finally {
    history.entries = original;
    await act(async () => root.unmount());
  }
});

it.each([
  { hasMore: false, busy: false, error: null, empty: false, visible: false },
  { hasMore: true, busy: false, error: null, empty: false, visible: true },
  { hasMore: true, busy: true, error: null, empty: false, visible: false },
  { hasMore: true, busy: false, error: "Synthetic failure", empty: false, visible: false },
  { hasMore: true, busy: false, error: null, empty: true, visible: false },
])("keeps background history pagination only when a usable next page exists: %j", async ({ empty, visible, ...state }) => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const originalEntries = history.entries;
  Object.assign(history, state);
  if (empty) history.entries = [];
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><BackgroundHistoryPicker onAttach={vi.fn()} /></I18nProvider>));
    await act(async () => onClick(allNodes(container).find(node => node.tagName === "BUTTON")!)());
    const button = allNodes(container).find(node => node.tagName === "BUTTON" && node.textContent === "載入較舊的對話");
    expect(Boolean(button)).toBe(visible);
    if (button) {
      await act(async () => onClick(button)());
      expect(history.loadMore).toHaveBeenCalledOnce();
    }
  } finally { history.entries = originalEntries; await act(async () => root.unmount()); }
});
