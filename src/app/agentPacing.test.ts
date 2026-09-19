import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadActiveSessionLimit,
  normalizeActiveSessionLimit,
  queueDependencyCandidates,
  saveActiveSessionLimit,
} from "./agentPacing";

describe("active session limit", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("only keeps a whole number the backend would accept", () => {
    expect(normalizeActiveSessionLimit(3)).toBe(3);
    expect(normalizeActiveSessionLimit(0)).toBeNull();
    expect(normalizeActiveSessionLimit(33)).toBeNull();
    expect(normalizeActiveSessionLimit(2.5)).toBeNull();
    expect(normalizeActiveSessionLimit("4")).toBeNull();
  });

  it("remembers a limit and forgets it again", () => {
    expect(loadActiveSessionLimit()).toBeNull();
    saveActiveSessionLimit(2);
    expect(loadActiveSessionLimit()).toBe(2);
    saveActiveSessionLimit(null);
    expect(loadActiveSessionLimit()).toBeNull();
  });

  it("ignores a stored value it cannot read", () => {
    localStorage.setItem("latticeterm.agentMaxActive.v1", "{broken");
    expect(loadActiveSessionLimit()).toBeNull();
  });
});

describe("queue dependency candidates", () => {
  const session = (sessionId: string, extra: object = {}) => ({ sessionId, ...extra });

  it("never offers the session itself or one from the other registry", () => {
    const sessions = [
      session("a"),
      session("b"),
      session("bg", { detached: true }),
    ];
    expect(queueDependencyCandidates(sessions, "a").map((s) => s.sessionId)).toEqual([
      "b",
    ]);
    expect(queueDependencyCandidates(sessions, "bg")).toEqual([]);
  });

  it("leaves out sessions that already wait on this one, directly or not", () => {
    const sessions = [
      session("a"),
      session("b", { waitsFor: "a" }),
      session("c", { waitsFor: "b" }),
      session("d"),
    ];
    expect(queueDependencyCandidates(sessions, "a").map((s) => s.sessionId)).toEqual([
      "d",
    ]);
    expect(queueDependencyCandidates(sessions, "c").map((s) => s.sessionId)).toEqual([
      "a",
      "b",
      "d",
    ]);
  });
});
