import { describe, expect, it } from "vitest";
import { renderTerminalPreview } from "./terminalPreview";

describe("read-only terminal preview", () => {
  it("replaces spinner redraws instead of concatenating each frame", async () => {
    const snapshot = "\x1b[2J\x1b[1;1H• W\x1b[1;1H• Wo\x1b[1;1H• Work\x1b[1;1H• Working\x1b[K";
    expect(await renderTerminalPreview(snapshot)).toBe("• Working");
  });

  it("honors cursor movement, erase-line and carriage returns", async () => {
    const snapshot = "old status\rnew\x1b[K\r\nline two\x1b[1A\rready\x1b[K";
    expect(await renderTerminalPreview(snapshot)).toBe("ready\nline two");
  });

  it("keeps Traditional Chinese, spacing and separate command lines readable", async () => {
    const snapshot = "\x1b[32m修正記憶交接\x1b[0m\r\n  git pull --ff-only\r\n  git push origin main";
    expect(await renderTerminalPreview(snapshot)).toBe("修正記憶交接\n  git pull --ff-only\n  git push origin main");
  });

  it("does not display terminal titles, hyperlinks or cursor control strings", async () => {
    const snapshot = "\x1b]0;private title\x07\x1b]8;;https://example.test\x1b\\readable\x1b]8;;\x1b\\\x1b[3;1Hnext";
    expect(await renderTerminalPreview(snapshot)).toBe("readable\n\nnext");
  });

  it("drops a clipped replay prefix without dropping the next screen update", async () => {
    expect(await renderTerminalPreview("0;3Hbroken\x1b[1;1H• Working\x1b[K", true)).toBe("• Working");
  });

  it("keeps ordinary output when there is no replay boundary", async () => {
    expect(await renderTerminalPreview("876 tests passed", true)).toBe("876 tests passed");
    expect(await renderTerminalPreview("")).toBe("");
  });

  it("does not duplicate output across independently rendered snapshots", async () => {
    const snapshot = "\x1b[1;1HWorking\x1b[1;1HDone\x1b[K";
    expect(await renderTerminalPreview(snapshot)).toBe("Done");
    expect(await renderTerminalPreview(snapshot)).toBe("Done");
  });
});
