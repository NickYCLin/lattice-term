import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { accountModelTargetKey, type AccountModelTarget } from "./accountModels";
import type { ChatModelChoice } from "./agentChat";
import { useAccountModels } from "./useAccountModels";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./nativeRuntime", () => ({ hasDesktopBackend: () => true }));

const target: AccountModelTarget = {
  definitionId: "codex", accountProfileId: null, configDirectory: null,
  accountName: "first", cliLabel: "Codex", signedOut: false, showAccount: false,
};
const key = accountModelTargetKey(target);
const models = (value: string): ChatModelChoice[] => [{ value, label: value, description: null, isDefault: false }];
let root: ReturnType<typeof createRoot> | null = null;
let api: ReturnType<typeof useAccountModels>;

function Probe({ enabled = true, targets = [target] }: { enabled?: boolean; targets?: AccountModelTarget[] }) {
  api = useAccountModels(targets, enabled);
  return null;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  vi.resetAllMocks();
});

async function render(enabled = true, targets = [target]) {
  root ??= createRoot(installFakeDom() as unknown as Element);
  Object.assign(globalThis, { __TAURI_INTERNALS__: { invoke } });
  await act(async () => root!.render(<Probe enabled={enabled} targets={targets} />));
  await act(async () => { await vi.dynamicImportSettled(); });
}

it("refreshes the model list when the picker is reopened", async () => {
  invoke.mockResolvedValueOnce(models("old")).mockResolvedValueOnce(models("new"));
  await render();
  expect(api[key]).toEqual({ state: "ready", models: models("old") });
  await render(false);
  await render();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(api[key]).toEqual({ state: "ready", models: models("new") });
});

it("does not publish an old response after logout and login", async () => {
  let finish!: (value: ChatModelChoice[]) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(models("new-account"));
  await render();
  await render(true, [{ ...target, signedOut: true }]);
  expect(api[key]).toBeUndefined();
  await render();
  await act(async () => finish(models("old-account")));
  expect(api[key]).toEqual({ state: "ready", models: models("new-account") });
});

it("refreshes when the account changes within the same configuration directory", async () => {
  invoke.mockResolvedValueOnce(models("first-account")).mockResolvedValueOnce(models("second-account"));
  await render();
  await render(true, [{ ...target, accountName: "second" }]);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(api[key]).toEqual({ state: "ready", models: models("second-account") });
});

it("ignores a closed picker's failed request after a newer request succeeds", async () => {
  let fail!: (reason: Error) => void;
  invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
    .mockResolvedValueOnce(models("current"));
  await render();
  await render(false);
  await render();
  await act(async () => fail(new Error("old request failed")));
  expect(api[key]).toEqual({ state: "ready", models: models("current") });
});

it("deduplicates identical targets and skips disposed StrictMode effects", async () => {
  invoke.mockResolvedValue(models("current"));
  root = createRoot(installFakeDom() as unknown as Element);
  Object.assign(globalThis, { __TAURI_INTERNALS__: { invoke } });
  await act(async () => root!.render(<StrictMode><Probe targets={[target, target]} /></StrictMode>));
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(api[key]).toEqual({ state: "ready", models: models("current") });
  expect(invoke).toHaveBeenCalledTimes(1);
});
