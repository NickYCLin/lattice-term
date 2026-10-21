import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { allNodes, installHostDom, props } from "../agents/testFixtures/interactionDom";
import { McpElicitation, parseElicitation } from "./McpElicitation";

afterEach(() => { vi.unstubAllGlobals(); });

async function setup(onAnswer = vi.fn(async () => {}), form = false) {
  const host = installHostDom();
  const invoke = vi.fn(async () => {});
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
  const request = parseElicitation(JSON.stringify(form
    ? { mode: "form", requestedSchema: { type: "object", properties: { branch: { type: "string", default: "main" } } } }
    : { mode: "url", url: "https://example.com/login" }))!;
  const root = createRoot(host as unknown as Element);
  await act(async () => { root.render(<I18nProvider locale="en"><McpElicitation request={request} onAnswer={onAnswer} /></I18nProvider>); });
  const buttons = () => allNodes(host).filter(node => node.tagName === "BUTTON");
  const open = () => props(buttons()[0]).onClick();
  const decline = () => props(buttons()[1]).onClick();
  const submit = () => props(allNodes(host).find(node => node.tagName === "FORM")!).onSubmit({ preventDefault() {} });
  return { host, root, invoke, onAnswer, buttons, open, decline, submit };
}

it("opens a login page once for synchronous repeated clicks", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const onAnswer = vi.fn(() => pending);
  const state = await setup(onAnswer);
  try {
    await act(async () => { state.open(); state.open(); await vi.waitFor(() => expect(onAnswer).toHaveBeenCalled()); });
    expect(state.invoke).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    await act(async () => { state.open(); state.decline(); });
    expect(state.invoke).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledTimes(1);
  } finally { await act(async () => { finish(); await pending; state.root.unmount(); }); }
});

it("does not decline a request while its page is opening", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const state = await setup();
  state.invoke.mockImplementation(() => pending);
  try {
    await act(async () => { state.open(); state.decline(); await vi.waitFor(() => expect(state.invoke).toHaveBeenCalled()); });
    expect(state.onAnswer).not.toHaveBeenCalled();
    await act(async () => { finish(); await pending; await vi.waitFor(() => expect(state.onAnswer).toHaveBeenCalledWith(true)); });
    expect(state.onAnswer).toHaveBeenCalledTimes(1);
  } finally { await act(async () => { finish(); await pending; state.root.unmount(); }); }
});

it("keeps a failed page open retryable without answering it", async () => {
  const state = await setup();
  state.invoke.mockRejectedValueOnce(new Error("open failed"));
  try {
    await act(async () => { state.open(); await vi.waitFor(() => expect(state.invoke).toHaveBeenCalled()); });
    expect(state.host.textContent).toContain("open failed");
    expect(state.onAnswer).not.toHaveBeenCalled();
    expect(props(state.buttons()[0]).disabled).toBe(false);
    await act(async () => { state.open(); await vi.waitFor(() => expect(state.onAnswer).toHaveBeenCalledWith(true)); });
    expect(state.invoke).toHaveBeenCalledTimes(2);
  } finally { await act(async () => { state.root.unmount(); }); }
});

it("does not open a page while its decline is awaiting confirmation", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const onAnswer = vi.fn(() => pending);
  const state = await setup(onAnswer);
  try {
    await act(async () => { state.decline(); state.open(); });
    expect(state.invoke).not.toHaveBeenCalled();
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(false);
  } finally { await act(async () => { finish(); await pending; state.root.unmount(); }); }
});

it("submits a form once and permits retry after a failed answer", async () => {
  let fail!: (reason: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
  const onAnswer = vi.fn(async () => {}).mockImplementationOnce(() => pending);
  const state = await setup(onAnswer, true);
  try {
    await act(async () => { state.submit(); state.submit(); });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    await act(async () => { fail(new Error("answer failed")); await pending.catch(() => {}); });
    expect(state.host.textContent).toContain("answer failed");
    await act(async () => { state.submit(); });
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenLastCalledWith(true, JSON.stringify({ branch: "main" }));
  } finally { await act(async () => { fail(new Error("cleanup")); await pending.catch(() => {}); state.root.unmount(); }); }
});
