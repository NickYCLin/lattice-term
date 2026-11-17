import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { HostNode,allNodes,installHostDom,props as reactProps } from "../agents/testFixtures/interactionDom";
import { NavRail } from "./NavRail";
import { navigationItemsFor } from "../../app/navigation";
let media:{matches:boolean;addEventListener:ReturnType<typeof vi.fn>;removeEventListener:ReturnType<typeof vi.fn>};
let host:HostNode,root:ReturnType<typeof createRoot>;
function props(node:HostNode){return reactProps(node)??{};}
const outside=new Set<(event:unknown)=>void>();
function buttons(){return allNodes(host).filter(node=>String(props(node).role).startsWith("menuitem"));}
function trigger(){return allNodes(host).find(node=>props(node)["aria-haspopup"])!;}
function popup(){return allNodes(host).find(node=>props(node).className==="composer-menu")!;}
async function click(node:HostNode){await act(async()=>props(node).onClick());}
async function key(node:HostNode,value:string){await act(async()=>props(node).onKeyDown({key:value,currentTarget:node,target:document.activeElement,nativeEvent:{},preventDefault(){},stopPropagation(){}}));}
beforeEach(()=>{
 media={matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()};
 host=installHostDom();root=createRoot(host as unknown as Element);outside.clear();vi.clearAllMocks();
 vi.stubGlobal("matchMedia",()=>media);
 vi.stubGlobal("localStorage",{getItem:()=>null,setItem:vi.fn()});
 Object.assign(window,{innerWidth:320,innerHeight:600,matchMedia:()=>media});
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

it("opens More, exposes every secondary route, preserves unread state and returns focus on Escape",async()=>{
 const select=vi.fn();await act(async()=>root.render(<I18nProvider locale="zh-TW"><NavRail mobile current="vault" items={navigationItemsFor("ios")} activityUnreadCount={4} onSelect={select}/></I18nProvider>));
 const anchor=trigger();expect(props(anchor)["aria-label"]).toBe("更多，活動有 4 個未讀");expect(props(anchor).className).toContain("is-active");
 await click(anchor);expect(buttons()).toHaveLength(3);expect(buttons().map(node=>node.textContent)).toEqual(["通道","金鑰保管庫","活動4"]);
 expect(props(buttons()[1])["aria-current"]).toBe("page");expect(props(popup()).style.left).toBeGreaterThanOrEqual(8);
 await key(popup(),"End");expect(document.activeElement).toBe(buttons()[2]);await key(popup(),"Escape");expect(document.activeElement).toBe(anchor);
 await click(anchor);await key(popup(),"ArrowDown");expect(document.activeElement).toBe(buttons()[1]);await key(popup(),"End");await key(popup(),"Enter");expect(select).toHaveBeenCalledWith("activity");expect(document.activeElement).toBe(anchor);expect(allNodes(host).some(node=>props(node).role==="menu")).toBe(false);
});
it("dismisses outside and restores all seven tabs without More when widened",async()=>{
 await act(async()=>root.render(<I18nProvider locale="zh-TW"><NavRail mobile current="connections" items={navigationItemsFor("ios")} onSelect={vi.fn()}/></I18nProvider>));
 await click(trigger());await act(async()=>{for(const fn of outside)fn({target:new HostNode("DIV",{})});});expect(allNodes(host).some(node=>props(node).role==="menu")).toBe(false);
 await click(trigger());media.matches=false;await act(async()=>media.addEventListener.mock.calls[0][1]());
 expect(allNodes(host).filter(node=>String(props(node).className).split(" ").includes("rail__item"))).toHaveLength(7);
 expect(allNodes(host).some(node=>props(node)["aria-haspopup"])).toBe(false);expect(host.textContent).not.toContain("更多");
});
