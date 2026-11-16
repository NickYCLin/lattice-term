import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { HostNode, allNodes, installHostDom, props as reactProps } from "../agents/testFixtures/interactionDom";
import { ComposerPermissionMenu } from "./ComposerPermissionMenu";
import { ComposerProjectMenu } from "./ComposerProjectMenu";
import { composerMenuPosition } from "./ComposerMenu";
const { invoke }=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HostNode,root:ReturnType<typeof createRoot>;
function props(node:HostNode){return reactProps(node)??{};}
const outside=new Set<(event:unknown)=>void>();
function buttons(){return allNodes(host).filter(node=>String(props(node).role).startsWith("menuitem"));}
function trigger(){return allNodes(host).find(node=>props(node)["aria-haspopup"])!;}
function popup(){return allNodes(host).find(node=>props(node).className==="composer-menu")!;}
async function click(node:HostNode){await act(async()=>props(node).onClick());}
async function key(node:HostNode,value:string){await act(async()=>props(node).onKeyDown({key:value,currentTarget:node,target:document.activeElement,nativeEvent:{},preventDefault(){},stopPropagation(){}}));}
beforeEach(()=>{
 host=installHostDom();root=createRoot(host as unknown as Element);outside.clear();vi.clearAllMocks();
 vi.stubGlobal("localStorage",{getItem:()=>null,setItem:vi.fn()});
 Object.assign(window,{innerWidth:320,innerHeight:600});
 document.addEventListener=((name:string,callback:(event:unknown)=>void)=>{if(name==="pointerdown")outside.add(callback);}) as typeof document.addEventListener;
 document.removeEventListener=((_name:string,callback:(event:unknown)=>void)=>outside.delete(callback)) as typeof document.removeEventListener;
 Object.defineProperties(HostNode.prototype,{
  getBoundingClientRect:{configurable:true,value:function(this:HostNode){return this.tagName==="BUTTON"?{left:280,top:550,bottom:580,height:30}:{height:240};}},
  contains:{configurable:true,value:function(this:HostNode,node:HostNode){return allNodes(this).includes(node);}},
  querySelectorAll:{configurable:true,value:function(this:HostNode,selector:string){return allNodes(this).filter(node=>selector.startsWith("input,")?node.tagName==="INPUT"||props(node)["aria-checked"]===true:node.tagName==="BUTTON"&&String(props(node).role).startsWith("menuitem")&&!props(node).disabled);}},
  querySelector:{configurable:true,value:function(this:HostNode,selector:string){return (this as unknown as {querySelectorAll:(s:string)=>HostNode[]}).querySelectorAll(selector)[0]??null;}},
  click:{configurable:true,value:function(this:HostNode){props(this).onClick();}},
 });
 vi.spyOn(HostNode.prototype,"focus").mockImplementation(function(this:HostNode){Object.assign(document,{activeElement:this});});
});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();for(const name of ["getBoundingClientRect","contains","querySelectorAll","querySelector","click"])Reflect.deleteProperty(HostNode.prototype,name);vi.unstubAllGlobals();});
const options=[{value:"ask" as const,label:"每次詢問",description:"執行前核准"},{value:"readOnly" as const,label:"唯讀",description:"不修改資料"},{value:"full" as const,label:"完整存取",description:"可讀寫檔案"}];
it("supports arrows, Home/End, Enter and Escape, explains options and returns focus",async()=>{
 const change=vi.fn();await act(async()=>root.render(<I18nProvider locale="zh-TW"><ComposerPermissionMenu value="ask" options={options} disabled={false} onChange={change}/></I18nProvider>));
 const anchor=trigger();await key(anchor,"ArrowDown");expect(document.activeElement).toBe(buttons()[0]);
 expect(popup().textContent).toContain("不修改資料");expect(popup().parentNode).toBe(host);
 expect(props(popup()).style.top).toBe(304);expect(props(popup()).style.left).toBe(8);
 await key(popup(),"End");expect(document.activeElement).toBe(buttons()[2]);await key(popup(),"ArrowDown");expect(document.activeElement).toBe(buttons()[0]);
 await key(popup(),"ArrowUp");expect(document.activeElement).toBe(buttons()[2]);await key(popup(),"Home");await key(popup(),"ArrowDown");await key(popup(),"Enter");
 expect(change).toHaveBeenCalledWith("readOnly");expect(document.activeElement).toBe(anchor);expect(allNodes(host).some(node=>props(node).role==="menu")).toBe(false);
 await click(anchor);await key(popup(),"Escape");expect(document.activeElement).toBe(anchor);
 await click(anchor);await key(popup(),"Tab");expect(document.activeElement).toBe(anchor);
 await click(anchor);await act(async()=>{for(const listener of outside)listener({target:new HostNode("DIV",{})});});expect(allNodes(host).some(node=>props(node).role==="menu")).toBe(false);
});
it("shows deduplicated recent folders, disables missing paths, searches and only opens the system chooser explicitly",async()=>{
 const choose=vi.fn(),change=vi.fn();
 const rows=[{path:"/synthetic/alias",at:3},{path:"/synthetic/real",at:2},{path:"/synthetic/missing",at:1}];
 invoke.mockImplementation(async(_command,args)=>args.paths.map((path:string)=>({path,canonicalPath:path.endsWith("missing")?null:"/synthetic/real"})));
 await act(async()=>root.render(<I18nProvider locale="zh-TW"><ComposerProjectMenu workingDirectory="" disabled={false} candidates={rows} onChoose={choose} onChange={change}/></I18nProvider>));
 await click(trigger());expect(choose).not.toHaveBeenCalled();expect(buttons()).toHaveLength(4);
 const missing=buttons().find(node=>node.textContent.includes("missing"))!;expect(props(missing).disabled).toBe(true);expect(missing.textContent).toContain("無法存取");
 const input=allNodes(host).find(node=>node.tagName==="INPUT")!;await act(async()=>props(input).onChange({target:{value:"alias"}}));expect(buttons()).toHaveLength(3);
 await act(async()=>root.render(<I18nProvider locale="zh-TW"><ComposerProjectMenu workingDirectory="" disabled={false} candidates={rows.map(row=>({...row,at:row.at+1}))} onChoose={choose} onChange={change}/></I18nProvider>));
 expect(props(input).value).toBe("alias");expect(invoke).toHaveBeenCalledTimes(1);
 await click(buttons()[0]);expect(change).toHaveBeenCalledWith("/synthetic/alias");expect(invoke).toHaveBeenLastCalledWith("project_directory_identities",{paths:["/synthetic/alias"]});
 await click(trigger());await click(buttons().find(node=>node.textContent==="一般對話")!);expect(change).toHaveBeenCalledWith("");
 await click(trigger());await click(buttons().find(node=>node.textContent==="選擇其他資料夾…")!);expect(choose).toHaveBeenCalledOnce();
});
it("does not select a folder deleted after opening or apply a late result after dismissal",async()=>{
 const change=vi.fn();invoke.mockResolvedValue([{path:"/synthetic/real",canonicalPath:"/synthetic/real"}]);
 const render=()=>root.render(<I18nProvider locale="zh-TW"><ComposerProjectMenu workingDirectory="" disabled={false} candidates={[{path:"/synthetic/real",at:1}]} onChoose={()=>{}} onChange={change}/></I18nProvider>);
 await act(async()=>render());await click(trigger());invoke.mockResolvedValue([{path:"/synthetic/real",canonicalPath:null}]);await click(buttons()[0]);expect(change).not.toHaveBeenCalled();
 await key(popup(),"Escape");invoke.mockResolvedValue([{path:"/synthetic/real",canonicalPath:"/synthetic/real"}]);await click(trigger());
 let finish!:(value:unknown)=>void;invoke.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));await click(buttons()[0]);await key(popup(),"Escape");
 await act(async()=>finish([{path:"/synthetic/real",canonicalPath:"/synthetic/real"}]));expect(change).not.toHaveBeenCalled();
});
it("clamps composer menus inside short and narrow viewports",()=>{
 for(const width of [320,760,1280]){const result=composerMenuPosition({left:width-20,top:550,bottom:580},360,800,{width,height:600});expect(result.left).toBeGreaterThanOrEqual(8);expect(result.left+result.width).toBeLessThanOrEqual(width-8);expect(result.top+result.maxHeight).toBeLessThanOrEqual(600-8);}
});
