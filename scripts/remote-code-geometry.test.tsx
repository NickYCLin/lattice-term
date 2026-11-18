import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n";
import { RemoteConnectFlow } from "../src/components/remote/RemoteConnectFlow";
import { RemoteQuickConnect } from "../src/components/remote/RemoteQuickConnect";
import { createConnectionProfile, emptyDraft } from "../src/domain/connection";
import type { RemoteApi } from "../src/app/useRemoteSessions";
vi.mock("../src/app/useSavedCredential", () => ({ useSavedCredential: () => ({ state: { mode: "missing" }, refresh: async () => {} }) }));
afterEach(() => vi.unstubAllGlobals());

it.skipIf(!process.env.LATTICE_GEOMETRY_BROWSER)("separates pairing icons from inputs at iPhone 13 width using real dialogs and styles", () => {
  vi.stubGlobal("window", { localStorage: { getItem: () => null } });
  const profile = createConnectionProfile({ ...emptyDraft("lattice"), name: "Synthetic host", hostname: "fixture.invalid" }, "synthetic");
  const remote = {} as RemoteApi;
  const variants = [
    renderToStaticMarkup(<I18nProvider locale="zh-TW"><RemoteConnectFlow profile={profile} remote={remote} onConnected={() => {}} onCancel={() => {}} platform="ios" /></I18nProvider>),
    renderToStaticMarkup(<I18nProvider locale="zh-TW"><RemoteQuickConnect remote={remote} onConnected={() => {}} onCancel={() => {}} /></I18nProvider>),
  ];
  const styles = [...readFileSync("src/styles/index.css", "utf8").matchAll(/@import "\.\/(.*?)"/g)]
    .map(match => readFileSync("src/styles/" + match[1], "utf8")).join("\n");
  const directory = mkdtempSync(join(tmpdir(), "lt-pairing-geometry-"));
  try {
    const file = join(directory, "fixture.html");
    writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body><script>
      const results=[];
      for(const [variant,markup] of ${JSON.stringify(variants)}.entries()) for(const theme of ['dark','light','dusk','linen','storybook','clarity']) {
        document.documentElement.dataset.theme=theme;
        document.body.innerHTML='<div class="app app--mobile">'+markup+'</div>';
        document.getAnimations().forEach(animation => animation.finish());
        const field=document.querySelector('.remote-code-field');
        const icon=field.querySelector('svg').getBoundingClientRect(), input=field.querySelector('input').getBoundingClientRect(), dialog=document.querySelector('[role=dialog]').getBoundingClientRect();
        results.push({variant,theme,width:innerWidth,gap:input.left-icon.right,centerDelta:Math.abs((input.top+input.bottom-icon.top-icon.bottom)/2),overflow:input.right>dialog.right||input.left<dialog.left, inputWidth:input.width});
      }
      const evidence=document.createElement('pre');evidence.id='evidence';evidence.hidden=true;evidence.textContent=JSON.stringify(results);document.body.append(evidence);
    </script></body></html>`);
    const result = spawnSync(process.env.LATTICE_GEOMETRY_BROWSER!, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      ...(process.env.CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), "--user-data-dir=" + join(directory, "browser"),
      "--dump-dom", "--window-size=390,844", "--screenshot=/tmp/lt-pairing-gap.png", "file://" + file],
      { encoding: "utf8", timeout: 30000, env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory } });
    expect(result.status, result.stderr).toBe(0);
    const results = JSON.parse(result.stdout.match(/<pre id="evidence" hidden="">(.*?)<\/pre>/s)![1]);
    expect(results).toHaveLength(12);
    for (const sample of results) {
      expect(sample.width, JSON.stringify(sample)).toBe(390);
      expect(sample.gap, JSON.stringify(sample)).toBeGreaterThanOrEqual(7.9);
      expect(sample.centerDelta, JSON.stringify(sample)).toBeLessThanOrEqual(1);
      expect(sample.overflow, JSON.stringify(sample)).toBe(false);
      expect(sample.inputWidth).toBeGreaterThan(100);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 35000);
