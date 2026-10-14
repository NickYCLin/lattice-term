import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n";
import { AgentSkillsPanel } from "../../src/components/agents/AgentSkillsPanel";
import { ConversationHandoffDialog } from "../../src/components/agents/ConversationHandoffDialog";
import { AgentSessionImages } from "../../src/components/agents/AgentSessionImages";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { attachTerminalScrollback } from "../../src/components/terminal/terminalScrollback";
import "../../src/styles/index.css";
import "../../src/components/terminal/terminalScrollback.css";
import "@xterm/xterm/css/xterm.css";

const catalog = [{ id: "codex", label: "Codex CLI", installed: true }, { id: "claude", label: "Claude Code", installed: true }] as never;
const evidence = { confirmations: 0, payload: "", renders: 0, fits: 0, mounts: 0 };
Object.assign(window, { fixtureEvidence: evidence });
function Fixture() {
  useEffect(() => { evidence.mounts++; }, []);
  const [handoff, setHandoff] = useState(false);
  const [revision, setRevision] = useState(0);
  return <I18nProvider locale="zh-TW"><main style={{ padding: 8, overflow: "auto", height: "100vh" }}>
    <button id="handoff" onClick={() => setHandoff(true)}>Open synthetic handoff</button>
    <button id="background" onClick={() => setRevision(value => value + 1)}>Synthetic background refresh {revision}</button>
    <AgentSessionImages sessionId="synthetic-only" active revision={revision} />
    <AgentSkillsPanel catalog={catalog} accountProfiles={[]} projectDirectory="/synthetic" />
    {handoff && <ConversationHandoffDialog source="Synthetic source (no readable native history)" definitions={catalog} profiles={[]}
      loadSummary={async () => { throw new Error("Synthetic missing history"); }} onCancel={() => setHandoff(false)}
      onConfirm={async summary => { evidence.confirmations++; evidence.payload = summary; if (evidence.confirmations === 1) throw new Error("Synthetic destination unavailable"); setHandoff(false); }} />}
  </main></I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
const host = document.getElementById("terminal")!;
const terminal = new Terminal({ fontSize: 13, fontFamily: "monospace", cursorBlink: false });
const fit = new FitAddon();
terminal.loadAddon(fit); terminal.open(host);
const refit = () => { evidence.fits++; fit.fit(); };
attachTerminalScrollback(terminal, refit, true);
terminal.onRender(() => evidence.renders++);
Object.assign(window, { fixtureWrite: () => new Promise<void>(resolve => terminal.write("SYNTHETIC OUTPUT\r\n", resolve)), fixtureFit: refit });
void document.fonts.ready.then(refit);
