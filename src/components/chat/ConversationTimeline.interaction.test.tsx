import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { allNodes, installHostDom, props, type HostNode } from "../agents/testFixtures/interactionDom";
import { ConversationTimeline, type TimelineRow } from "./ConversationTimeline";
import { ReadableToolCard } from "./ReadableToolCard";
import { presentTool } from "../../app/toolPresentation";
import { ChatInputSettings } from "../settings/ChatInputSettings";
import { defaultPreferences } from "../../app/preferences";

afterEach(() => { vi.unstubAllGlobals(); });
function hidden(node: HostNode | undefined): boolean { return Boolean(node && (node.attributes.hidden !== undefined || hidden(node.parentNode ?? undefined))); }
const rows: TimelineRow[] = [
  { id: "u", aliases: ["u"], user: true, process: false, node: <p>question</p> },
  ...["cat file", "rg needle"].map((command, index) => ({ id: `tool${index}`, aliases: [`tool${index}`, `result${index}`], user: false, process: true,
    exploration: index ? { files: 0, searches: 1, directories: 0 } : { files: 1, searches: 0, directories: 0 }, node: <p>{command}</p> })),
  ...["approval", "error", "diff", "image", "pending-question", "final-answer"].map(id => ({ id, aliases: [id], user: false, process: false, node: <p>{id}</p> })),
];
const render = (match?: string, latestFinished = true, collapseDefault = true) => <I18nProvider locale="zh-TW"><ConversationTimeline rows={rows} match={match} latestFinished={latestFinished} collapseDefault={collapseDefault} /></I18nProvider>;
function paragraph(host: HostNode, text: string) { return allNodes(host).find(node => node.tagName === "P" && node.textContent === text); }

it("collapses completed process rows, retains protected content, and expands search hits including merged results", async () => {
  const host = installHostDom(), root = createRoot(host as unknown as Element);
  try {
    await act(async () => root.render(render()));
    expect(hidden(paragraph(host, "cat file"))).toBe(true);
    expect(props(paragraph(host, "rg needle")!.parentNode!.parentNode!).hidden).toBe(true);
    for (const name of ["approval", "error", "diff", "image", "pending-question", "final-answer"]) expect(hidden(paragraph(host, name))).toBe(false);
    expect(host.textContent).toContain("已處理 2 個步驟");
    await act(async () => root.render(render("result1")));
    expect(hidden(paragraph(host, "rg needle"))).toBe(false);
    expect(allNodes(host).find(node => String(node.attributes.class).includes("chat-exploration__toggle"))?.attributes["aria-expanded"]).toBe(true);
    await act(async () => root.render(render()));
    expect(hidden(paragraph(host, "cat file"))).toBe(true);
    const toggle = allNodes(host).find(node => node.tagName === "BUTTON")!;
    await act(async () => props(toggle).onClick());
    const exploration = allNodes(host).find(node => String(node.attributes.class).includes("chat-exploration__toggle"))!;
    await act(async () => props(exploration).onClick());
    expect(hidden(paragraph(host, "cat file"))).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
it("does not offer collapse during active turns and combines exploration counts", async () => {
  const host = installHostDom(), root = createRoot(host as unknown as Element);
  try {
    await act(async () => root.render(render(undefined, false)));
    expect(allNodes(host).some(node => String(node.attributes.class).includes("chat-process-toggle"))).toBe(false);
    expect(hidden(paragraph(host, "cat file"))).toBe(false);
    expect(host.textContent).toContain("已探索 1 個檔案、1 次搜尋、0 次目錄查詢");
    expect(allNodes(host).find(node => String(node.attributes.class).includes("chat-exploration__toggle"))?.attributes["aria-expanded"]).toBe(true);
  } finally { await act(async () => root.unmount()); }
});
it("shows a command preview, expands complete output and exposes the original call on search", async () => {
  const host = installHostDom(), root = createRoot(host as unknown as Element);
  const output = "one\ntwo\nthree\nfour\nfive";
  const tool = presentTool({ id: "exec", aliases: ["exec"], name: "exec", input: 'text(await tools.exec_command({cmd:"ls",workdir:"/synthetic"}));', output, done: true, isError: false });
  const renderCard = (forceOpen = false) => <I18nProvider locale="zh-TW"><ReadableToolCard tool={tool} forceOpen={forceOpen} /></I18nProvider>;
  try {
    await act(async () => root.render(renderCard()));
    expect(host.textContent).toContain("已執行ls");
    expect(host.textContent).not.toContain(tool.input);
    const result = allNodes(host).find(node => node.attributes.class === "chat-readable-tool__result")!;
    expect(result.textContent).not.toContain("four");
    await act(async () => props(allNodes(result).find(node => node.tagName === "BUTTON")!).onClick());
    expect(result.textContent).toContain("five");
    await act(async () => root.render(renderCard(true)));
    expect(allNodes(host).find(node => node.tagName === "DETAILS")?.attributes.open).toBeDefined();
    expect(host.textContent).toContain(tool.input);
  } finally { await act(async () => root.unmount()); }
});
it("saves the completed-turn default through the chat settings control", async () => {
  const host = installHostDom(), root = createRoot(host as unknown as Element), change = vi.fn();
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><ChatInputSettings preferences={defaultPreferences} onChange={change} /></I18nProvider>));
    const input = allNodes(host).find(node => node.tagName === "INPUT")!;
    expect(props(input).checked).toBe(false);
    await act(async () => props(input).onChange({ target: { checked: true } }));
    expect(change).toHaveBeenCalledWith({ chatCollapseCompletedTurns: true });
  } finally { await act(async () => root.unmount()); }
});

it("preserves a tool card and its local state when a second exploration step forms a group", async () => {
  const host = installHostDom(), root = createRoot(host as unknown as Element);
  const make = (id: string): TimelineRow => {
    const tool = presentTool({ id, aliases:[id], name:"command", input:"ls", output:"ok", done:true, isError:false });
    return { id, aliases:[id], user:false, process:true, exploration:tool.exploration, node:<ReadableToolCard tool={tool} /> };
  };
  const first = make("first");
  const render = (second: boolean, finished: boolean) => <I18nProvider locale="zh-TW"><ConversationTimeline rows={[first, ...(second ? [make("second")] : [])]}
    latestFinished={finished} collapseDefault={false} /></I18nProvider>;
  try {
    await act(async () => root.render(render(false, false)));
    const card = allNodes(host).find(node=>node.tagName==="SECTION")!;
    const details = allNodes(card).find(node=>node.tagName==="DETAILS")!;
    Object.assign(details, { open:true });
    await act(async () => props(details).onToggle({ target:details, currentTarget:details }));
    expect(props(details).open).toBe(true);
    await act(async () => root.render(render(true, false)));
    expect(allNodes(host).find(node=>node.tagName==="SECTION")).toBe(card);
    expect(props(details).open).toBe(true);
    await act(async () => root.render(render(true, true)));
    expect(allNodes(host).find(node=>node.tagName==="SECTION")).toBe(card);
  } finally { await act(async () => root.unmount()); }
});
