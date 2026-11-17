import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportTextFile } from "./fileExport";
import { exportEncryptedBackup } from "./encryptedBackup";
import { localFileError } from "./localFiles";
import { defaultPreferences } from "./preferences";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("file exports", () => {
  const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
  const createElement = vi.fn(() => anchor);
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      localStorage: { getItem: () => null },
    });
    vi.stubGlobal("document", {
      createElement,
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:export"), revokeObjectURL });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for native iOS persistence and returns the actual collision-safe filename", async () => {
    let finish!: (name: string) => void;
    invoke.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    let complete = false;
    const pending = exportTextFile("{}", "latticeterm-connections-test.json", "ios")
      .then((result) => { complete = true; return result; });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(complete).toBe(false);
    expect(invoke).toHaveBeenCalledWith("ios_export_document", {
      filename: "latticeterm-connections-test.json", contents: "{}",
    });
    finish("latticeterm-connections-test (2).json");
    await expect(pending).resolves.toEqual({
      destination: "ios-documents", filename: "latticeterm-connections-test (2).json",
    });
    expect(createElement).not.toHaveBeenCalled();
  });

  it("propagates native write failures without claiming a download succeeded", async () => {
    invoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(exportTextFile("{}", "test.json", "ios")).rejects.toThrow("disk full");
    expect(createElement).not.toHaveBeenCalled();
  });

  it.each([undefined, "browser", "macos", "windows", "linux", "android"])(
    "preserves downloads on %s and delays URL cleanup until consumption can begin",
    async (platform) => {
      await expect(exportTextFile("{}", "profiles.json", platform)).resolves.toEqual({ destination: "download" });
      expect(anchor.download).toBe("profiles.json");
      expect(anchor.click).toHaveBeenCalledOnce();
      expect(anchor.remove).toHaveBeenCalledOnce();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:export");
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("saves the encrypted envelope before reporting backup export success", async () => {
    const envelope = { contents: "encrypted envelope", createdAt: 0, appFileCount: 2, vaultIncluded: true };
    invoke.mockResolvedValueOnce(envelope).mockResolvedValueOnce("backup.latticeterm-backup");
    const result = await exportEncryptedBackup("user supplied password", defaultPreferences, "ios");
    expect(invoke).toHaveBeenNthCalledWith(2, "ios_export_document", {
      contents: envelope.contents,
      filename: "LatticeTerm-1970-01-01T00-00-00-000Z.latticeterm-backup",
    });
    expect(result.delivery).toEqual({ destination: "ios-documents", filename: "backup.latticeterm-backup" });
    expect(createElement).not.toHaveBeenCalled();
  });

  it("does not report a backup as exported when persistence fails after encryption", async () => {
    invoke.mockResolvedValueOnce({ contents: "encrypted", createdAt: 0 })
      .mockRejectedValueOnce(new Error("write failed"));
    await expect(exportEncryptedBackup("user supplied password", defaultPreferences, "ios"))
      .rejects.toThrow("write failed");
  });
});

it.each(["fileExport.insufficientSpace","fileExport.spaceUnavailable"])("exposes a translatable iOS export failure without reporting success: %s", async code=>{
  invoke.mockRejectedValueOnce(code);
  await expect(exportTextFile("synthetic","latticeterm-connections-test.json","ios")).rejects.toBe(code);
  expect(localFileError(code,key=>`translated:${key}`)).toBe(`translated:${code}`);
});
