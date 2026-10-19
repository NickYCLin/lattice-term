import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installHostDom } from "../agents/testFixtures/interactionDom";
import { useAppDialogs } from "./useAppDialogs";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const root = createRoot(installHostDom() as unknown as Element);
  let dialogs!: ReturnType<typeof useAppDialogs>;
  function Harness() {
    dialogs = useAppDialogs();
    return null;
  }
  return { root, render: () => root.render(<StrictMode><Harness /></StrictMode>), get dialogs() { return dialogs; } };
}

const confirmRequest = { title: "Delete file", body: "Delete this file?", confirmLabel: "Delete", cancelLabel: "Cancel" };
const promptRequest = { title: "Rename file", label: "Name", confirmLabel: "Rename", cancelLabel: "Cancel" };

it("keeps replacement requests working after Strict Mode effect replay", async () => {
  const harness = setup();
  await act(async () => harness.render());
  const replaced = vi.fn();
  const current = vi.fn();
  try {
    await act(async () => { void harness.dialogs.confirm(confirmRequest).then(replaced); });
    expect(replaced).not.toHaveBeenCalled();
    await act(async () => { void harness.dialogs.confirm(confirmRequest).then(current); });
    expect(replaced).toHaveBeenCalledExactlyOnceWith(false);
    expect(current).not.toHaveBeenCalled();
  } finally { await act(async () => harness.root.unmount()); }
  expect(replaced).toHaveBeenCalledTimes(1);
  expect(current).toHaveBeenCalledExactlyOnceWith(false);
});

it("settles pending confirmation and prompt as cancelled when the owner unmounts", async () => {
  const harness = setup();
  await act(async () => harness.render());
  const confirmed = vi.fn();
  const prompted = vi.fn();
  await act(async () => {
    void harness.dialogs.confirm(confirmRequest).then(confirmed);
    void harness.dialogs.prompt(promptRequest).then(prompted);
  });
  await act(async () => harness.root.unmount());
  expect(confirmed).toHaveBeenCalledExactlyOnceWith(false);
  expect(prompted).toHaveBeenCalledExactlyOnceWith(null);
});

it("rejects stale callbacks after the owner unmounts instead of leaving new promises pending", async () => {
  const harness = setup();
  await act(async () => harness.render());
  const stale = harness.dialogs;
  await act(async () => harness.root.unmount());
  const confirmed = vi.fn();
  const prompted = vi.fn();
  await act(async () => {
    void stale.confirm(confirmRequest).then(confirmed);
    void stale.prompt(promptRequest).then(prompted);
  });
  expect(confirmed).toHaveBeenCalledExactlyOnceWith(false);
  expect(prompted).toHaveBeenCalledExactlyOnceWith(null);
});
