export interface HerdrAgent {
  pane_id: string;
  terminal_id: string;
  agent: string | null;
  name: string | null;
  title: string | null;
  cwd: string | null;
  agent_status: string;
  interactive_ready: boolean;
}

export interface HerdrSnapshot { agent: HerdrAgent; text: string }

export function herdrAgentKey(agent: HerdrAgent): string {
  return JSON.stringify([agent.pane_id, agent.terminal_id]);
}

export function herdrCanPrompt(agent: HerdrAgent | null, text: string): boolean {
  return Boolean(agent?.interactive_ready && ["idle", "done"].includes(agent.agent_status)
    && text.trim() && new TextEncoder().encode(text).length <= 16_000 && !/[\u0000-\u001f\u007f-\u009f]/u.test(text));
}
