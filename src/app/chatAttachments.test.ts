import { describe, expect, it } from "vitest";
import { mergeAttachmentPaths, pasteContainsImage } from "./chatAttachments";

describe("chat attachments", () => {
  it("adds images from native paths without losing existing attachments or duplicating files", () => {
    const original = [{ path: "/work/report.pdf", name: "report.pdf", isImage: false }];
    expect(mergeAttachmentPaths(original, ["C:\\work\\截圖.PNG", "/work/report.pdf", "C:\\work\\截圖.PNG", ""]))
      .toEqual([...original, { path: "C:\\work\\截圖.PNG", name: "截圖.PNG", isImage: true }]);
    expect(original).toHaveLength(1);
  });
  it("rejects additions beyond the native limit as a whole", () => {
    const files = mergeAttachmentPaths([], Array.from({ length: 9 }, (_, index) => `/file-${index}.txt`))!;
    expect(mergeAttachmentPaths(files, ["/last.png"])).toHaveLength(10);
    expect(mergeAttachmentPaths(files, ["/a.png", "/b.png"])).toBeNull();
    expect(files).toHaveLength(9);
    expect(mergeAttachmentPaths(files, ["/file-0.txt"])).toHaveLength(9);
  });
  it("leaves text, HTML, and copied file paths to normal paste", () => {
    expect(pasteContainsImage([{ kind: "file", type: "image/png" }])).toBe(true);
    expect(pasteContainsImage([{ kind: "string", type: "text/plain" }, { kind: "string", type: "text/html" }])).toBe(false);
    expect(pasteContainsImage([{ kind: "file", type: "application/pdf" }])).toBe(false);
    expect(pasteContainsImage([])).toBe(false);
  });
});
