import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { themeIds, resolveTheme } from "../src/app/themes";

it.each(themeIds)("keeps %s primary and danger labels readable without a browser", theme => {
  const tokens = readFileSync("src/styles/tokens.css", "utf8");
  const palette = tokens.match(new RegExp('\\[data-theme="' + theme + '"\\] \\{([^}]+)\\}'))![1];
  const values = Object.fromEntries([...palette.matchAll(/--([\w-]+): (#[\da-f]+);/g)].map(match => [match[1], match[2]]));
  const luminance = (hex: string) => hex.slice(1).match(/../g)!.map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  for (const background of ["accent", "accent-hover", "accent-press", "danger"]) {
    const pair = [luminance(values[background]), luminance(values["accent-ink"])].sort((first, second) => second - first);
    expect((pair[0] + 0.05) / (pair[1] + 0.05), theme + " " + background).toBeGreaterThanOrEqual(4.5);
  }
});

function buttonClasses() {
  const classes = new Set(["button button--primary", "button button--secondary", "button button--danger", "button button--ghost button--danger"]);
  const visitDirectory = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visitDirectory(path);
      else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
        const source = readFileSync(path, "utf8");
        for (const tag of source.matchAll(/<button\b[\s\S]*?>/g)) {
          const attribute = tag[0].match(/className=(?:"([^"]+)"|\{`([^`]+)`\})/);
          if (!attribute) continue;
          const value = attribute[1] ?? attribute[2];
          const base = value.split("${")[0].trim();
          if (!base || base.endsWith("-")) continue;
          classes.add(base);
          for (const state of ["is-active", "is-selected", "is-on"]) {
            if (value.includes(state)) classes.add(base + " " + state);
          }
        }
      }
    }
  };
  visitDirectory("src");
  classes.add("segmented__btn is-selected");
  classes.add("terminal-keybar__key is-armed");
  classes.add("audit-ssh-selected");
  for (const base of ["segmented__option", "chat-mode__tab", "inspector__tab", "session-composer__icon", "session-header__files-button", "rail__item", "sidebar__row", "cli-switch__pill", "chat-thread", "remote-host-mode__option", "palette__item"]) classes.add(base + (base === "segmented__option" ? " is-selected" : " is-active"));
  for (const base of ["protocol-option", "language-option", "theme-option", "project-launcher__cli", "agents-broadcast__target"]) classes.add(base + " is-selected");
  for (const variant of ["", "protocol-ssh", "protocol-rdp", "protocol-sftp", "protocol-vnc", "env-production", "env-staging", "env-development"]) classes.add(("filter-chip is-on " + variant).trim());
  return [...classes].sort();
}

it("resolves the system theme to both audited palettes", () => {
  const original = globalThis.window;
  try {
    for (const matches of [false, true]) {
      globalThis.window = { matchMedia: () => ({ matches }) } as unknown as Window & typeof globalThis;
      expect(resolveTheme("system")).toBe(matches ? "light" : "dark");
    }
  } finally {
    globalThis.window = original;
  }
});

it.skipIf(!process.env.LATTICE_CONTRAST_BROWSER)("checks button text and selected indicators in every theme", () => {
  const directory = mkdtempSync(join(tmpdir(), "lattice-button-contrast-"));
  const styles = [...readFileSync("src/styles/index.css", "utf8").matchAll(/@import "\.\/(.*?)"/g)]
    .map(match => readFileSync("src/styles/" + match[1], "utf8")).join("\n")
    .replaceAll(":hover", ".audit-hover").replaceAll(":active", ".audit-pressed").replaceAll(":focus-visible", ".audit-focus");
  const script = `
    const failures = [], results = [];
    const context = document.createElement('canvas').getContext('2d');
    const rgba = color => { context.clearRect(0,0,1,1); context.fillStyle = color; context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data].map((value,index) => index === 3 ? value/255 : value); };
    const blend = (front,back) => front.slice(0,3).map((value,index) => value*front[3]+back[index]*(1-front[3])).concat(1);
    const luminance = color => color.slice(0,3).map(value => { const normalized=value/255; return normalized <= 0.04045 ? normalized/12.92 : ((normalized+0.055)/1.055)**2.4; }).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
    const contrast = (first,second) => { const values=[luminance(first),luminance(second)].sort((first,second)=>second-first); return (values[0]+0.05)/(values[1]+0.05); };
    const background = element => { if(!element) return [255,255,255,1]; return blend(rgba(getComputedStyle(element).backgroundColor),background(element.parentElement)); };
    for (const theme of ${JSON.stringify(themeIds)}) {
      document.documentElement.dataset.theme=theme;
      for (const surface of ['canvas','canvas-deep','surface-solid','surface-raised','surface-hover','surface-active','surface-selected']) {
        const host=document.getElementById('host'); host.style.background='var(--'+surface+')';
        for (const classes of ${JSON.stringify(buttonClasses())}) {
          for(const state of ['default','hover','pressed','focus','disabled']) {
            host.innerHTML='<button>操作</button>';
            const button=host.firstElementChild; button.className=classes+' audit-'+state; button.disabled=state==='disabled';
            host.className=classes==='audit-ssh-selected' ? 'ssh-pane-switch' : '';
            button.setAttribute('aria-pressed',String(classes==='audit-ssh-selected'));
            button.setAttribute('aria-selected',String(classes.includes('is-selected')));
            const style=getComputedStyle(button), backdrop=background(button), parent=background(host);
            if(state==='disabled') { results.push({theme,surface,classes,state,opacity:style.opacity}); continue; }
            const colors=style.backgroundImage==='none' ? [backdrop] : [...style.backgroundImage.matchAll(/(?:rgb|rgba|color)\\([^)]*\\)/g)].map(match=>blend(rgba(match[0]),backdrop));
            const ratios=colors.map(color=>contrast(blend(rgba(style.color),color),color));
            const minimum=Math.min(...ratios);
            const invisible=/connection-card__open|agent-session-images__tile|chat-attachment--preview/.test(classes);
            if(!invisible && minimum<4.5) failures.push({theme,surface,classes,state,kind:'text',ratio:minimum});
            if(/button--secondary|capture-button|protocol-option|language-option|theme-option|remote-host-mode__option|project-launcher__cli|cli-switch__pill|filter-chip/.test(classes)) {
              const ratio=contrast(blend(rgba(style.borderTopColor),parent),parent);
              if(ratio<3) failures.push({theme,surface,classes,state,kind:'border',ratio});
            }
            const childMarkup=classes.startsWith('theme-option') ? '<span class="theme-option__hint">主題說明</span>'
              : classes.startsWith('language-option') ? '<span class="language-option__code">TW</span><span class="language-option__text"><small>語言說明</small></span>'
              : classes.startsWith('cli-switch__pill') ? '<span class="cli-switch__model">模型</span>'
              : classes.startsWith('remote-host-mode__option') ? '<small>連線說明</small>'
              : classes.startsWith('chat-mode__tab') ? '<span class="chat-mode__badge">3</span>' : '';
            button.innerHTML=childMarkup;
            for(const child of button.querySelectorAll('small, .theme-option__hint, .language-option__code, .cli-switch__model, .chat-mode__badge')) {
              const childStyle=getComputedStyle(child), childBackground=background(child), foreground=rgba(childStyle.color);
              foreground[3]*=Number(childStyle.opacity);
              const ratio=contrast(blend(foreground,childBackground),childBackground);
              if(ratio<4.5) failures.push({theme,surface,classes,state,kind:'child text',ratio});
            }
            if(/segmented__(option|btn) is-selected/.test(classes) || classes==='chat-mode__tab is-active' || classes==='inspector__tab is-active' || classes==='audit-ssh-selected') {
              const ratio=contrast(backdrop,blend(rgba(getComputedStyle(document.documentElement).getPropertyValue('--surface-active')),parent));
              if(ratio<3) failures.push({theme,surface,classes,state,kind:'selection',ratio});
            }
            if(state==='focus' && (style.outlineStyle==='none' || parseFloat(style.outlineWidth)<2)) failures.push({theme,surface,classes,state,kind:'focus'});
            if(state==='focus') {
              const ratio=contrast(rgba(style.outlineColor),rgba(getComputedStyle(document.documentElement).getPropertyValue('--canvas-deep')));
              if(ratio<3) failures.push({theme,surface,classes,state,kind:'focus contrast',ratio});
            }
            results.push({theme,surface,classes,state,ratio:minimum});
          }
        }
      }
    }
    document.getElementById('evidence').textContent=JSON.stringify({failures,results});
  `;
  const html = '<!doctype html><meta charset="utf-8"><style>' + styles + '</style><style>*{transition:none!important;animation:none!important}#host{padding:20px}</style><div id="host"></div><pre id="evidence"></pre><script>' + script + '</script>';
  const file = join(directory, "fixture.html");
  writeFileSync(file, html);
  const result = spawnSync(process.env.LATTICE_CONTRAST_BROWSER!, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + join(directory, "browser"), "--dump-dom", pathToFileURL(resolve(file)).href], { encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  expect(result.status, result.stderr).toBe(0);
  const evidence = JSON.parse(result.stdout.match(/<pre id="evidence">(.*?)<\/pre>/s)![1]);
  writeFileSync(join(directory, "contrast.json"), JSON.stringify(evidence, null, 2));
  console.log("Contrast evidence:", directory, "samples:", evidence.results.length);
  expect(evidence.failures).toEqual([]);
}, 125000);
