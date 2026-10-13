import { expect, it } from "vitest";
import { proxyChatHistory } from "./proxyChat";

it("keeps user attachments and assistant replies in conversation order", () => {
  expect(proxyChatHistory([
    { type: "user", id: "one", at: 1, text: "看附件", attachments: [{ path: "C:/notes.txt", name: "notes.txt", isImage: false }] },
    { type: "text", id: "reply", text: "已讀取" },
    { type: "user", id: "two", at: 2, text: "再比較圖片", attachments: [{ path: "C:/photo.png", name: "photo.png", isImage: true }] },
  ])).toEqual([
    { role: "user", text: "看附件", attachments: [{ path: "C:/notes.txt" }] },
    { role: "assistant", text: "已讀取", attachments: [] },
    { role: "user", text: "再比較圖片", attachments: [{ path: "C:/photo.png" }] },
  ]);
});

it("does not turn reasoning or tool output into an assistant reply", () => {
  expect(proxyChatHistory([{ type: "reasoning", id: "thought", text: "private reasoning" }])).toEqual([]);
});
