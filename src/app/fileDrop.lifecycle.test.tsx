import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { allNodes, installHostDom, props } from "../components/agents/testFixtures/interactionDom";
import { useFileDrop } from "./fileDrop";

vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ onDragDropEvent: async () => () => {} }) }));
afterEach(() => { vi.unstubAllGlobals(); });

it.each(["unmount", "disable", "active"])("reports drop errors only for an active lifetime: %s", async change => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const onError = vi.fn();
  let rejectDrop!: (error: Error) => void;
  const onFiles = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectDrop = reject; }));
  function Probe({ disabled }: { disabled: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const { dragging: _dragging, ...handlers } = useFileDrop({ ref, disabled, onPaths: () => {}, onFiles, onError });
    return <div ref={ref} {...handlers}>Drop</div>;
  }
  let unmounted = false;
  try {
    await act(async () => root.render(<Probe disabled={false} />));
    const drop = props(allNodes(host).find(node => node.tagName === "DIV" && props(node)?.onDrop)!).onDrop;
    await act(async () => drop({ dataTransfer: { types: ["Files"], files: [{}] }, preventDefault() {}, stopPropagation() {} }));
    expect(onFiles).toHaveBeenCalledTimes(1);
    if (change === "unmount") {
      await act(async () => root.unmount());
      unmounted = true;
    } else if (change === "disable") {
      await act(async () => root.render(<Probe disabled={true} />));
      await act(async () => root.render(<Probe disabled={false} />));
    }
    await act(async () => rejectDrop(new Error("old drop failed")));
    if (change === "active") expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "old drop failed" }));
    else expect(onError).not.toHaveBeenCalled();
  } finally { if (!unmounted) await act(async () => root.unmount()); }
});

it("keeps active drops serialized across disabled changes", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const onError = vi.fn();
  const finishes: (() => void)[] = [];
  const onFiles = vi.fn(() => new Promise<void>(resolve => { finishes.push(resolve); }));
  function Probe({ disabled }: { disabled: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const { dragging: _dragging, ...handlers } = useFileDrop({ ref, disabled, onPaths: () => {}, onFiles, onError });
    return <div ref={ref} {...handlers}>Drop</div>;
  }
  const drop = async () => { await act(async () => props(allNodes(host).find(node => node.tagName === "DIV" && props(node)?.onDrop)!).onDrop({ dataTransfer: { types: ["Files"], files: [{}] }, preventDefault() {}, stopPropagation() {} })); };
  try {
    await act(async () => root.render(<Probe disabled={false} />));
    await drop();
    await act(async () => root.render(<Probe disabled={true} />));
    await act(async () => root.render(<Probe disabled={false} />));
    await drop();
    expect(onFiles).toHaveBeenCalledTimes(1);
    await act(async () => finishes[0]());
    await drop();
    expect(onFiles).toHaveBeenCalledTimes(2);
    await drop();
    expect(onFiles).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  } finally { await act(async () => { finishes.forEach(finish => finish()); root.unmount(); }); }
});
