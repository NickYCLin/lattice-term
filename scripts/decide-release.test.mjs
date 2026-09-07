import { describe, expect, it } from "vitest";
import { classifyCommit, decideRelease, RELEASE_INTERVAL_MS, unreleasedCommits } from "./decide-release.mjs";

const now = Date.parse("2026-09-15T02:17:00Z");
const weekAgo = new Date(now - RELEASE_INTERVAL_MS).toISOString();
const recent = new Date(now - 60_000).toISOString();
const commit = (subject, body = "") => ({ subject, body });
const decide = (overrides = {}) => decideRelease({
  commits: [commit("fix(ui): 修正提示遮擋")], lastPublishedAt: weekAgo,
  now, eventName: "schedule", ...overrides,
});

describe("classifyCommit", () => {
  it("recognizes user-facing changes and excludes maintenance", () => {
    for (const type of ["feat", "fix", "perf"]) expect(classifyCommit(commit(`${type}(ui): 調整`)).releasable).toBe(true);
    for (const type of ["docs", "test", "ci", "chore", "style", "refactor", "build"]) expect(classifyCommit(commit(`${type}: 調整`)).releasable).toBe(false);
  });
  it("recognizes both breaking-change annotations without changing cadence", () => {
    expect(classifyCommit(commit("feat(api)!: 改變協定")).breaking).toBe(true);
    expect(classifyCommit(commit("feat(api): 改變協定", "BREAKING CHANGE: 舊協定不相容")).breaking).toBe(true);
  });
  it("retains unlabelled commits for review instead of hiding real work", () => {
    expect(classifyCommit(commit("改善操作"))).toEqual({ type: null, releasable: true, breaking: false });
  });
});

describe("weekly stable release", () => {
  it.each(["push", "pull_request", "workflow_run", "unknown"])("never publishes from %s, even with force", (eventName) => {
    expect(decide({ eventName, forced: true, commits: [commit("feat(api)!: 改變協定")] }).release).toBe(false);
  });
  it("holds three or many commits until seven days have elapsed", () => {
    for (const count of [3, 100]) expect(decide({ lastPublishedAt: recent, commits: Array.from({ length: count }, () => commit("fix(ui): 同一問題的後續修正")) }).release).toBe(false);
  });
  it("does not treat breaking changes as urgent", () => {
    expect(decide({ lastPublishedAt: recent, commits: [commit("feat(api)!: 改變協定")] }).release).toBe(false);
  });
  it("allows one useful fix at the exact seven-day boundary", () => {
    expect(decide({ now: now - 1 }).release).toBe(false);
    expect(decide().release).toBe(true);
  });
  it("still handles breaking changes classified as refactors", () => {
    expect(decide({ commits: [commit("refactor(api)!: 更換相容介面")] }).release).toBe(true);
  });
  it("skips empty and maintenance-only releases even when forced", () => {
    for (const commits of [[], [commit("ci: 調整檢查"), commit("docs: 補說明")]]) {
      expect(decide({ commits, eventName: "workflow_dispatch", forced: true }).release).toBe(false);
    }
  });
  it("only an explicit emergency dispatch can bypass the interval", () => {
    expect(decide({ lastPublishedAt: recent, eventName: "workflow_dispatch", forced: true }).release).toBe(true);
    expect(decide({ lastPublishedAt: recent, eventName: "workflow_dispatch" }).release).toBe(false);
    expect(decide({ lastPublishedAt: recent, forced: true }).release).toBe(false);
  });
  it.each([undefined, "", "invalid", "2027-01-01T00:00:00Z"])("fails closed for publication metadata %s", (lastPublishedAt) => {
    expect(decide({ lastPublishedAt, eventName: "workflow_dispatch", forced: true }).release).toBe(false);
  });
  it("requires confirmed absence for the first release", () => {
    expect(decide({ lastPublishedAt: null }).release).toBe(true);
    expect(decide({ lastPublishedAt: null, now: NaN }).release).toBe(false);
  });
  it.each([undefined, "", "--all", "v2.0.1-rc.1", "v2.0.0\nHEAD"])("rejects unsafe or unconfirmed published tag %s", (tag) => {
    expect(() => unreleasedCommits(tag)).toThrow();
  });
});
