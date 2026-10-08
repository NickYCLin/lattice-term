import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ComposerAttachments, ComposerPopover } from "./ConversationComposer";
import { ComposerVoiceControls } from "./ComposerVoiceControls";
import { ChatView } from "../../views/ChatView";
import { fakeAgentApi, fakeAutomationsApi, fakeChatApi, fakeDefinition, fakeSession, fakeThread } from "../../app/testFixtures/agentApis";
import { SessionConversationPane } from "./SessionConversationPane";
import { desktopChatAccess } from "../../app/desktopChat";
import { removeConversationDraft } from "../../app/useConversationDraft";

const clipboard = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: clipboard.invoke, convertFileSrc: (path: string) => path }));
const sessionConversation = vi.hoisted(() => ({ send: vi.fn(), acknowledge: vi.fn() }));
vi.mock("../../app/useSessionConversation", () => ({
  useSessionConversation: () => ({
    messages: [], availability: "ready", truncated: false, readError: null, loading: false,
    slow: false, output: "", outputError: null, sendError: null, sending: false, queued: null,
    send: sessionConversation.send, acknowledge: sessionConversation.acknowledge,
    approval: null, answering: false, answerError: null, answer: vi.fn(),
  }),
}));

const voice = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), speak: vi.fn(), stopSpeaking: vi.fn(), listening: false }));
vi.mock("../../app/sessionVoice", () => ({
  useDictation: () => ({ mode: "local", listening: voice.listening, start: voice.start, stop: voice.stop }),
  speechSynthesisAvailable: () => true,
  speak: voice.speak,
  stopSpeaking: voice.stopSpeaking,
  spokenSessionReply: () => "",
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
  constructor(readonly tagName: string, document: Record<string, unknown>) {
    this.ownerDocument = document;
  }
  get nodeName() { return this.tagName; }
  get options() { return allNodes(this).filter(node => node.tagName === "OPTION"); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.text + this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.childNodes = []; }
  appendChild(child: HostNode) { this.childNodes.push(child); child.parentNode = this; return child; }
  removeChild(child: HostNode) { this.childNodes = this.childNodes.filter((node) => node !== child); child.parentNode = null; return child; }
  insertBefore(child: HostNode, before: HostNode) { this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; if (name === "value") this.value = value; }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}

function allNodes(node: HostNode): HostNode[] {
  return [node, ...node.childNodes.flatMap(allNodes)];
}

function onClick(node: HostNode): () => void {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, { onClick: () => void }>)[key].onClick;
}

function installHostDom() {
  const document: Record<string, unknown> = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {} };
  document.createElement = (name: string) => new HostNode(name.toUpperCase(), document);
  document.createElementNS = (_namespace: string, name: string) => new HostNode(name.toUpperCase(), document);
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
    document, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {},
    setInterval, clearInterval, setTimeout, clearTimeout,
  };
  document.defaultView = window;
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", HostNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return container;
}


beforeEach(() => {
  vi.useFakeTimers();
  clipboard.invoke.mockReset().mockResolvedValue(null);
  sessionConversation.send.mockReset().mockResolvedValue(true);
  voice.listening = false;
  voice.start.mockReset();
  voice.stop.mockReset();
  voice.stopSpeaking.mockReset();
  voice.speak.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const kind of ["thread", "session"] as const) {
    for (const id of ["t1", "composer-draft-a", "composer-draft-b"]) removeConversationDraft(kind, id);
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function inputProps(container: HostNode) {
  const node = allNodes(container).find(candidate => candidate.tagName === "TEXTAREA")!;
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))!;
  return (node as unknown as Record<string, {
    value: string;
    onChange: (event: { target: { value: string } }) => void;
    onPaste: (event: { clipboardData: { items: { kind: string; type: string }[]; getData: () => string }; preventDefault: () => void }) => void;
  }>)[key];
}

it.each(["thread", "session"] as const)("keeps unsent text, files and screenshots in the %s composer after switching pages", async kind => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const threads = [fakeThread({ id: "composer-draft-a" }), fakeThread({ id: "composer-draft-b" })];
  const chat = fakeChatApi({ threads, activeThreadId: threads[0].id });
  const agents = fakeAgentApi({ catalog: [fakeDefinition()] });
  const renderComposer = (id: string) => {
    chat.activeThreadId = id;
    root.render(<I18nProvider locale="zh-TW">{kind === "thread"
      ? <ChatView agents={agents} chat={chat} automations={fakeAutomationsApi()} onOpenSession={() => {}} />
      : <SessionConversationPane key={id} session={fakeSession({ sessionId: id, stateSource: "integration" })}
        agents={agents} onOpenTerminal={() => {}} onSessionReplaced={() => {}} />}</I18nProvider>);
  };
  clipboard.invoke.mockImplementation(async (command: string) => {
    if (command === "agent_chat_paste_files") return ["C:/drafts/notes.txt", "C:/drafts/screenshot.png"];
    if (command === "agent_chat_keep_image_preview") return "C:/drafts/preview.png";
    return null;
  });
  try {
    await act(async () => renderComposer(threads[0].id));
    await act(async () => inputProps(container).onChange({ target: { value: "尚未送出的說明" } }));
    const preventDefault = vi.fn();
    await act(async () => inputProps(container).onPaste({
      clipboardData: { items: [{ kind: "file", type: "image/png" }], getData: () => "" }, preventDefault,
    }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("screenshot.png");
    expect(container.textContent).toContain("notes.txt");
    await act(async () => renderComposer(threads[1].id));
    expect(inputProps(container).value).toBe("");
    expect(container.textContent).not.toContain("screenshot.png");
    if (kind === "thread") expect(desktopChatAccess.drafts.has(threads[0].id)).toBe(true);
    await act(async () => root.render(null));
    await act(async () => renderComposer(threads[0].id));
    expect(inputProps(container).value).toBe("尚未送出的說明");
    expect(container.textContent).toContain("screenshot.png");
    expect(container.textContent).toContain("notes.txt");
    expect(chat.send).not.toHaveBeenCalled();
    expect(sessionConversation.send).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it.each(["thread", "session"] as const)("keeps a delayed screenshot paste on its original %s composer", async kind => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const threads = [fakeThread({ id: "composer-draft-a" }), fakeThread({ id: "composer-draft-b" })];
  const chat = fakeChatApi({ threads, activeThreadId: threads[0].id });
  const agents = fakeAgentApi({ catalog: [fakeDefinition()] });
  let finishPaste!: (path: string) => void;
  const pending = new Promise<string>(resolve => { finishPaste = resolve; });
  const renderComposer = (id: string) => {
    chat.activeThreadId = id;
    root.render(<I18nProvider locale="zh-TW">{kind === "thread"
      ? <ChatView agents={agents} chat={chat} automations={fakeAutomationsApi()} onOpenSession={() => {}} />
      : <SessionConversationPane key={id} session={fakeSession({ sessionId: id, stateSource: "integration" })}
        agents={agents} onOpenTerminal={() => {}} onSessionReplaced={() => {}} />}</I18nProvider>);
  };
  clipboard.invoke.mockImplementation(async (command: string) => {
    if (command === "agent_chat_paste_files") return [];
    if (command === "agent_chat_paste_image") return pending;
    if (command === "agent_chat_keep_image_preview") return "C:/drafts/preview.png";
    return null;
  });
  try {
    await act(async () => renderComposer(threads[0].id));
    await act(async () => inputProps(container).onPaste({
      clipboardData: { items: [{ kind: "file", type: "image/png" }], getData: () => "" }, preventDefault: vi.fn(),
    }));
    await act(async () => renderComposer(threads[1].id));
    await act(async () => finishPaste("C:/drafts/screenshot.png"));
    expect(container.textContent).not.toContain("screenshot.png");
    await act(async () => renderComposer(threads[0].id));
    expect(container.textContent).toContain("screenshot.png");
    expect(clipboard.invoke).toHaveBeenCalledWith("agent_chat_paste_image", { threadId: threads[0].id });
  } finally { await act(async () => root.unmount()); }
});

it("offers files and images under plus, without a clipboard action", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const choose = vi.fn();
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ComposerAttachments disabled={false} onChoose={choose} /></I18nProvider>));
    await act(async () => onClick(allNodes(container).find(node => node.tagName === "BUTTON")!)());
    const buttons = allNodes(container).filter(node => node.tagName === "BUTTON");
    expect(buttons.map(node => node.textContent)).toEqual(["", "加入圖片", "加入檔案"]);
    expect(container.textContent).not.toContain("剪貼簿");
    await act(async () => onClick(buttons[2])());
    expect(choose).toHaveBeenCalledExactlyOnceWith("file");
    expect(allNodes(container).some(node => node.attributes.role === "dialog")).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

it("does not expose a model dialog while settings are locked", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const change = vi.fn();
  try {
    await act(async () => root.render(<ComposerPopover model label="test-model" disabled open onOpenChange={change}>choices</ComposerPopover>));
    expect(change).toHaveBeenCalledExactlyOnceWith(false);
    expect(container.textContent).not.toContain("choices");
  } finally { await act(async () => root.unmount()); }
});

it("starts dictation and swaps the empty voice action for send when content exists", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const focus = vi.fn();
  const inputRef = createRef<HTMLTextAreaElement>();
  inputRef.current = { focus } as unknown as HTMLTextAreaElement;
  const props = { inputRef, draft: "", hasContent: false, blocked: false, working: false, sending: false,
    canSend: false, sendLabel: "送出", replyVersion: "old", replyText: "歷史回覆", onText: vi.fn(), onSubmit: vi.fn(), onNotice: vi.fn() };
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ComposerVoiceControls {...props} /></I18nProvider>));
    let buttons = allNodes(container).filter(node => node.tagName === "BUTTON");
    expect(buttons[1].attributes.class).toBe("session-composer__voice");
    await act(async () => onClick(buttons[0])());
    expect(focus).toHaveBeenCalledOnce();
    expect(voice.start).toHaveBeenCalledOnce();
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ComposerVoiceControls {...props} draft="草稿" hasContent canSend /></I18nProvider>));
    buttons = allNodes(container).filter(node => node.tagName === "BUTTON");
    expect(buttons[1].attributes.class).toBe("chat-send");
    expect(buttons[1].attributes.type).toBe("submit");
  } finally { await act(async () => root.unmount()); }
});

it("waits for an idle reply before speaking or auto-sending and stops without sending", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const props = { inputRef: createRef<HTMLTextAreaElement>(), draft: "", hasContent: false, blocked: false,
    working: false, sending: false, canSend: false, sendLabel: "送出", replyVersion: "old", replyText: "歷史回覆",
    onText: vi.fn(), onSubmit: vi.fn(), onNotice: vi.fn() };
  const renderVoice = (changes: Partial<typeof props> = {}) => root.render(<I18nProvider locale="zh-TW"><ComposerVoiceControls {...props} {...changes} /></I18nProvider>);
  try {
    await act(async () => renderVoice());
    await act(async () => onClick(allNodes(container).filter(node => node.tagName === "BUTTON")[1])());
    expect(voice.speak).not.toHaveBeenCalled();
    await act(async () => { renderVoice({ working: true, draft: "新指令", hasContent: true, canSend: true, replyVersion: "new", replyText: "最新回覆" }); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(voice.speak).not.toHaveBeenCalled();
    await act(async () => renderVoice({ replyVersion: "new", replyText: "最新回覆" }));
    expect(voice.speak).toHaveBeenCalledExactlyOnceWith("最新回覆", "zh-Hant-TW");
    await act(async () => renderVoice({ draft: "新指令", hasContent: true, canSend: true, replyVersion: "new", replyText: "最新回覆" }));
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(props.onSubmit).toHaveBeenCalledOnce();
    await act(async () => onClick(allNodes(container).filter(node => node.tagName === "BUTTON")[1])());
    expect(voice.stop).toHaveBeenCalledWith(true);
    expect(voice.stopSpeaking).toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(props.onSubmit).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});

it("opens native source and model choices from the composer without closing on a source change", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const thread = fakeThread({ model: "test-model", items: [{ type: "text", id: "reply", text: "回覆" }] });
  const chat = fakeChatApi({ threads: [thread], activeThreadId: thread.id });
  const agents = fakeAgentApi({ catalog: [fakeDefinition(), fakeDefinition({ id: "claude", label: "Claude Code" })] });
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ChatView agents={agents} chat={chat} automations={fakeAutomationsApi()} onOpenSession={() => {}} /></I18nProvider>));
    const modelButton = allNodes(container).find(node => node.attributes.class === "session-composer__model")!;
    await act(async () => onClick(modelButton)());
    const source = allNodes(container).find(node => node.tagName === "SELECT")!;
    const sourceKey = Object.keys(source).find(name => name.startsWith("__reactProps$"))!;
    const sourceChange = (source as unknown as Record<string, { onChange: (event: { currentTarget: { value: string } }) => void }>)[sourceKey].onChange;
    const option = allNodes(source).find(node => node.tagName === "OPTION" && node.textContent.includes("Claude Code"))!;
    await act(async () => sourceChange({ currentTarget: { value: option.attributes.value } }));
    expect(chat.updateThread).toHaveBeenCalledWith(thread.id, expect.objectContaining({ definitionId: "claude", model: "", accountProfileId: null }));
    expect(allNodes(container).some(node => node.attributes.role === "dialog" && node.attributes["aria-label"] === "test-model")).toBe(true);
  } finally { await act(async () => root.unmount()); }
});

it("preserves IME, Shift+Enter and busy-turn queueing on the native textarea", async () => {
  const container = installHostDom();
  const root = createRoot(container as unknown as Element);
  const thread = fakeThread({ items: [{ type: "text", id: "reply", text: "回覆" }] });
  const chat = fakeChatApi({ threads: [thread], activeThreadId: thread.id });
  const agents = fakeAgentApi();
  const renderChat = () => root.render(<I18nProvider locale="zh-TW"><ChatView agents={agents} chat={chat} automations={fakeAutomationsApi()} onOpenSession={() => {}} /></I18nProvider>);
  const inputProps = () => {
    const input = allNodes(container).find(node => node.tagName === "TEXTAREA")!;
    const key = Object.keys(input).find(name => name.startsWith("__reactProps$"))!;
    return (input as unknown as Record<string, {
      onChange: (event: { target: { value: string } }) => void;
      onKeyDown: (event: { key: string; shiftKey: boolean; nativeEvent: { key: string; isComposing: boolean }; preventDefault: () => void }) => void;
    }>)[key];
  };
  const preventDefault = vi.fn();
  try {
    await act(async () => renderChat());
    await act(async () => inputProps().onChange({ target: { value: "第一則" } }));
    await act(async () => inputProps().onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { key: "Enter", isComposing: true }, preventDefault }));
    await act(async () => inputProps().onKeyDown({ key: "Enter", shiftKey: true, nativeEvent: { key: "Enter", isComposing: false }, preventDefault }));
    expect(chat.send).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    await act(async () => inputProps().onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { key: "Enter", isComposing: false }, preventDefault }));
    expect(chat.send).toHaveBeenCalledWith(thread.id, "第一則", [], null, undefined, []);
    thread.runningTurnId = "turn-1";
    await act(async () => renderChat());
    await act(async () => inputProps().onChange({ target: { value: "下一則" } }));
    await act(async () => inputProps().onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { key: "Enter", isComposing: false }, preventDefault }));
    expect(chat.enqueue).toHaveBeenCalledWith(thread.id, "下一則", [], null, []);
    expect(chat.send).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});
