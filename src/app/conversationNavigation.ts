import { useEffect, useState } from "react";
import type { ChatItem } from "./agentChat";
const KEY = "latticeterm.chatPins.v1";
const EVENT = "latticeterm:chat-pins";
function readPins(): string[] { try { const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length <= 256).slice(0, 500) : []; } catch { return []; } }
export function useConversationPins() {
  const [pins, setPins] = useState(readPins);
  useEffect(() => { const update = () => setPins(readPins()); window.addEventListener(EVENT, update); window.addEventListener("storage", update); return () => { window.removeEventListener(EVENT, update); window.removeEventListener("storage", update); }; }, []);
  function toggle(id: string) { const current = readPins(); const next = current.includes(id) ? current.filter(entry => entry !== id) : [id, ...current].slice(0, 500); localStorage.setItem(KEY, JSON.stringify(next)); setPins(next); window.dispatchEvent(new Event(EVENT)); }
  return { pins, toggle };
}
export function searchConversation(items: readonly ChatItem[], query: string): string[] {
  const needle = query.trim().toLocaleLowerCase(); if (!needle) return [];
  return items.filter(item => {
    const text = item.type === "native" ? `${item.record.text}\n${item.record.input??""}\n${item.record.output??""}` : "text" in item ? item.text : item.type === "tool" ? `${item.name}\n${item.summary}\n${item.output ?? ""}` : item.type === "plan" ? item.steps.map(step => step.text).join("\n") : item.type === "goal" ? item.goal?.objective ?? "" : "";
    return text.toLocaleLowerCase().includes(needle);
  }).map(item => item.id);
}
export function conversationLink(id: string): string { return `latticeterm://chat/${encodeURIComponent(id)}`; }
export function parseConversationLink(value: string): string | null { return /^latticeterm:\/\/chat\/([a-zA-Z0-9_-]{1,256})$/.exec(value)?.[1] ?? null; }

export function sessionConversationLink(id: string): string { return `latticeterm://session/${encodeURIComponent(id)}`; }
export function parseConversationLocation(value: string): { kind: "chat" | "session"; id: string } | null {
  const match = /^latticeterm:\/\/(chat|session)\/([a-zA-Z0-9_-]{1,256})$/.exec(value);
  return match ? { kind: match[1] as "chat" | "session", id: match[2] } : null;
}
