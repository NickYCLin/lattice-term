import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { fakeDefinition } from "../../app/testFixtures/agentApis";
import { AgentSkillsPanel } from "./AgentSkillsPanel";
import { allNodes, installHostDom, props } from "./testFixtures/interactionDom";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => { vi.unstubAllGlobals(); invoke.mockReset(); });

it("counts distinct metadata and retains same-name skills with different descriptions", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const first = { name: "Synthetic skill", source: "project", description: "First description" };
  invoke.mockResolvedValue([first, first, { ...first, description: "Second description" }]);
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><AgentSkillsPanel catalog={[fakeDefinition()]} accountProfiles={[]} projectDirectory="/synthetic" /></I18nProvider>));
    expect(allNodes(host).filter(node => node.tagName === "DETAILS")).toHaveLength(2);
    const badge = allNodes(host).find(node => node.attributes.class?.includes("badge"));
    expect(badge?.textContent).toContain("2");
  } finally { await act(async () => root.unmount()); }
});

it("searches many metadata-only skills, filters source, clears no-results and resets on target switch", async () => {
  const host = installHostDom();
  const root = createRoot(host as unknown as Element);
  const skills = Array.from({ length: 200 }, (_, index) => ({ name: `fixture-${index}`, source: index % 2 ? "user" : "project", description: `Description ${index}`, kind: "skill" }));
  invoke.mockResolvedValue(skills);
  const catalog = [fakeDefinition(), fakeDefinition({ id: "claude", label: "Claude Code" })];
  try {
    await act(async () => root.render(<I18nProvider locale="zh-TW"><AgentSkillsPanel catalog={catalog} accountProfiles={[]} projectDirectory="/synthetic" /></I18nProvider>));
    expect(allNodes(host).filter(node => node.tagName === "DETAILS")).toHaveLength(200);
    const search = () => allNodes(host).find(node => node.tagName === "INPUT")!;
    const source = () => allNodes(host).filter(node => node.tagName === "SELECT")[1];
    await act(async () => props(search()).onChange({ currentTarget: { value: "fixture-19" } }));
    expect(allNodes(host).filter(node => node.tagName === "DETAILS")).toHaveLength(11);
    await act(async () => props(source()).onChange({ currentTarget: { value: "user" } }));
    expect(allNodes(host).filter(node => node.tagName === "DETAILS")).toHaveLength(6);
    await act(async () => props(search()).onChange({ currentTarget: { value: "absent" } }));
    expect(host.textContent).toContain("沒有符合");
    await act(async () => props(allNodes(host).find(node => node.tagName === "BUTTON" && node.textContent === "清除篩選")!).onClick());
    expect(allNodes(host).filter(node => node.tagName === "DETAILS")).toHaveLength(200);
    invoke.mockResolvedValue([]);
    await act(async () => props(allNodes(host).find(node => node.tagName === "SELECT")!).onChange({ currentTarget: { value: "claude:default" } }));
    expect(allNodes(host).filter(node => node.tagName === "DETAILS")).toHaveLength(0);
    expect(invoke).toHaveBeenLastCalledWith("agent_chat_skills", { definitionId: "claude", workingDirectory: "/synthetic", profileConfigPath: null });
  } finally { await act(async () => root.unmount()); }
});
