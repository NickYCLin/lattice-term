import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConnectionCard } from "../src/components/connections/ConnectionCard";
import { createConnectionProfile, emptyDraft, protocolCatalog } from "../src/domain/connection";
import { I18nProvider } from "../src/i18n";

it.skipIf(!process.env.LATTICE_GEOMETRY_BROWSER)("keeps card geometry stable across repeated group toggles", () => {
  const directory = mkdtempSync(join(tmpdir(), "lattice-card-geometry-"));
  const styles = [...readFileSync("src/styles/index.css", "utf8").matchAll(/@import "\.\/(.*?)"/g)]
    .map(match => readFileSync("src/styles/" + match[1], "utf8")).join("\n");
  const profile = createConnectionProfile({ ...emptyDraft(), name: "合成長主機名稱".repeat(8), hostname: "fixture.invalid", username: "fixture" }, "fixture");
  const cardMarkup = (multiple: boolean, connectable: boolean) => renderToStaticMarkup(<I18nProvider locale="zh-TW"><ConnectionCard
    profile={profile} selected={false} onSelect={() => {}} onEdit={() => {}} onDuplicate={() => {}}
    onDelete={() => {}} onToggleFavorite={() => {}} onConnect={connectable ? () => {} : undefined}
    linked={multiple ? protocolCatalog.slice(1).map(protocol => ({ profile: createConnectionProfile({ ...emptyDraft(protocol.id),
      hostname: "fixture.invalid", name: "另一條合成長路線".repeat(10) }, protocol.id), onConnect: () => {} })) : []} /></I18nProvider>);
  const variants = [cardMarkup(false, true), cardMarkup(true, true), cardMarkup(false, false)];
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body>
    <div class="connections__scroll" style="width:320px;height:300px;flex:none;padding:12px;box-sizing:border-box">
    <ul class="connection-grid">${variants[0]}</ul><details id="group"><summary>合成群組</summary><div style="height:900px">其他連線</div></details></div>
    <pre id="evidence"></pre><script>
    const rect = element => { const bounds = element.getBoundingClientRect(); return {x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height}; };
    const measure = () => ({card:rect(document.querySelector('.connection-card')),buttons:[...document.querySelectorAll('.connection-card__go')].map(rect),actions:rect(document.querySelector('.connection-card__actions')),overflow:document.querySelector('.connection-card').scrollWidth > document.querySelector('.connection-card').clientWidth});
    const results = [];
    for (const [variant, markup] of ${JSON.stringify(variants)}.entries()) {
    document.querySelector('.connection-grid').innerHTML = markup;
    for (const width of [320,480,760]) {
      document.querySelector('.connections__scroll').style.width = width + 'px';
      group.open = false; const before = measure();
      const toggles = []; for(let index=0;index<10;index++){ group.open = !group.open; toggles.push(measure()); }
      results.push({variant,width,before,toggles});
    }
    }
    evidence.textContent = JSON.stringify(results);
    </script></body></html>`;
  const file = join(directory, "fixture.html");
  writeFileSync(file, html);
  const result = spawnSync(process.env.LATTICE_GEOMETRY_BROWSER!, ["--headless", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--user-data-dir=" + join(directory, "browser"), "--dump-dom", "--window-size=1000,700",
    "--screenshot=" + join(directory, "fixture.png"), "file://" + file],
  { encoding: "utf8", timeout: 30000, env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory } });
  expect(result.status, result.stderr).toBe(0);
  const evidence = JSON.parse(result.stdout.match(/<pre id="evidence">(.*?)<\/pre>/s)![1]);
  writeFileSync(join(directory, "geometry.json"), JSON.stringify(evidence, null, 2));
  console.log("Geometry evidence:", directory);
  for (const sample of evidence) {
    expect(sample.before.overflow).toBe(false);
    for (const measurement of sample.toggles) expect(measurement).toEqual(sample.before);
  }
}, 35000);
