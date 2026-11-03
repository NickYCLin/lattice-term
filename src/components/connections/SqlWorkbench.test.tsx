import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { installFakeDom } from "../../app/testFixtures/hookDom";
import type { SqlWorkbenchState } from "../../domain/sqlWorkbench";
import { SqlWorkbench } from "./SqlWorkbench";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app/useRuntimeSummary", () => ({ useRuntimeSummary: () => ({ host: "tauri", summary: { platform: "windows" } }) }));
type Host = Record<string, unknown> & { childNodes?: Host[] };
type Props = { children?: unknown; type?: string; checked?: boolean; disabled?: boolean; value?: string; "aria-label"?: string; onClick?: () => void; onChange?: (event: {target:{value?:string;checked?:boolean}}) => void; onPointerDown?: (event: unknown) => void; onPointerUp?: (event: unknown) => void };
function props(node: Host): Props[] {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return [...(key ? [node[key] as Props] : []), ...(node.childNodes ?? []).flatMap(props)];
}
let container: ReturnType<typeof installFakeDom>;
let root: ReturnType<typeof createRoot>;
let panel: SqlWorkbenchState;
beforeEach(() => {
  vi.useFakeTimers(); container = installFakeDom();
  document.createElementNS = ((_namespace: string | null, name: string) => document.createElement(name)) as typeof document.createElementNS;
  root = createRoot(container as unknown as Element);
  panel = {id:"a".repeat(32),profileId:"fixture",name:"測試庫",sql:"SELECT 1",revision:0,busy:false,shareRead:false,shareEdit:false,detached:false,updatedBy:"user",lastSql:"",result:null,error:null};
  invoke.mockImplementation(async (command: string, {action}: {action?: Record<string, unknown>} = {}) => {
    if (command === "database_popout") { panel = {...panel,detached:true}; return; }
    if (command !== "database_workbench") throw Error(command);
    if (action?.kind === "edit") {
      if (action.revision !== panel.revision) throw Error("草稿已變更");
      panel = {...panel,sql:String(action.sql),revision:panel.revision+1};
    }
    if (action?.kind === "execute") {
      if (action.revision !== panel.revision) throw Error("草稿已變更");
      panel = {...panel,revision:panel.revision+2,lastSql:panel.sql,result:{columns:[],rows:[],truncated:false,cellCharacterLimit:512,stableOrder:false,affectedRows:1}};
    }
    return structuredClone(panel);
  });
});
afterEach(async () => { await act(async()=>root.unmount()); vi.useRealTimers(); vi.clearAllMocks(); });
async function render() { await act(async()=>root.render(<SqlWorkbench profileId="fixture" mcpAllowed />)); }
async function click(label: string) {
  const button = props(container).find((p)=>p.children === label && p.onClick);
  expect(button,label).toBeDefined(); expect(button!.disabled,label).not.toBe(true);
  await act(async()=>button!.onClick!());
}
async function type(sql: string) { await act(async()=>props(container).find((p)=>p["aria-label"] === "SQL 語法")!.onChange!({target:{value:sql}})); }

it("syncs the exact dirty SQL before confirmation and executes a write only after explicit acceptance", async()=>{
  await render(); await type("DELETE FROM sample WHERE id=1"); await click("執行增刪修…");
  expect(invoke.mock.calls.some(([,p])=>p?.action?.kind === "execute")).toBe(false);
  expect(props(container).find((p)=>p.children === "確認執行這份 SQL")?.disabled).toBe(true);
  await act(async()=>{props(container).find((p)=>p["aria-label"] === "確認執行資料變更")!.onChange!({target:{checked:true}});});
  await click("確認執行這份 SQL");
  expect(invoke).toHaveBeenCalledWith("database_workbench",{action:{kind:"execute",id:panel.id,revision:1,confirmedWrite:true}});
  expect(panel.lastSql).toBe("DELETE FROM sample WHERE id=1");
});

it("keeps human edits when MCP changes the shared revision and does not overwrite the newer draft", async()=>{
  await render(); await type("SELECT 'human'");
  panel = {...panel,sql:"SELECT 'mcp'",updatedBy:"mcp",revision:1};
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(props(container).find((p)=>p["aria-label"] === "SQL 語法")!.value).toBe("SELECT 'human'");
  await click("同步草稿"); expect(panel.sql).toBe("SELECT 'mcp'");
  await click("重新載入共享草稿");
  expect(props(container).find((p)=>p["aria-label"] === "SQL 語法")!.value).toBe("SELECT 'mcp'");
  expect(invoke.mock.calls.some(([,p])=>p?.action?.kind === "execute")).toBe(false);
});

it("invalidates write confirmation when the shared draft changes", async()=>{
  await render(); await type("UPDATE sample SET value=1 WHERE id=1"); await click("執行增刪修…");
  panel = {...panel,sql:"DELETE FROM sample",updatedBy:"mcp",revision:panel.revision+1};
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(props(container).some((p)=>p.children === "確認執行這份 SQL")).toBe(false);
});

it("detaches the same backend workspace and restores its draft when the separate window closes", async()=>{
  await render(); await type("SELECT 'shared'"); await click("移至獨立視窗");
  expect(invoke).toHaveBeenCalledWith("database_popout",{id:panel.id,x:null,y:null});
  expect(props(container).some((p)=>p.children === "顯示 SQL 視窗")).toBe(true);
  panel = {...panel,detached:false}; await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(props(container).find((p)=>p["aria-label"] === "SQL 語法")!.value).toBe("SELECT 'shared'");
});

it("connects the title drag gesture to the same popout operation when released outside the window", async()=>{
  await render();
  const header = props(container).find((p)=>p.onPointerDown)!;
  header.onPointerDown!({screenX:100,screenY:100,pointerId:1,target:{closest:()=>null},currentTarget:{setPointerCapture:()=>{}}});
  await act(async()=>header.onPointerUp!({screenX:1200,screenY:300,clientX:-10,clientY:300}));
  expect(invoke).toHaveBeenCalledWith("database_popout",{id:panel.id,x:1170,y:280});
});
