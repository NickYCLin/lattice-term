import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { allNodes, installHostDom } from "../components/agents/testFixtures/interactionDom";
import { RelativeActivity, relativeActivity } from "./relativeActivity";
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it("formats relative activity with Intl in each locale and rejects unknown dates",()=>{
  const now=Date.UTC(2026,10,16,12);
  expect(relativeActivity(now-180_000,now,"zh-TW")).toBe(new Intl.RelativeTimeFormat("zh-TW",{numeric:"auto",style:"short"}).format(-3,"minute"));
  expect(relativeActivity(now-7_200_000,now,"en-US")).toBe(new Intl.RelativeTimeFormat("en-US",{numeric:"auto",style:"short"}).format(-2,"hour"));
  expect(relativeActivity(now+60_000,now,"en")).toBe("now");
  for(const at of [0,NaN,Infinity,1e20]) expect(relativeActivity(at,now,"en")).toBeNull();
});
it("uses one shared minute clock and only rerenders time nodes while preserving the sidebar row",async()=>{
  vi.useFakeTimers();const now=Date.UTC(2026,10,16,12);vi.setSystemTime(now);
  const host=installHostDom(),root=createRoot(host as unknown as Element);let renders=0;
  function Row(){renders++;return <div><span>title</span><RelativeActivity at={now-180_000}/><RelativeActivity at={now-7_200_000}/></div>;}
  try{
    await act(async()=>root.render(<I18nProvider locale="en"><Row/></I18nProvider>));
    const time=allNodes(host).find(node=>node.tagName==="TIME");expect(time?.textContent).toContain("3 min");
    expect(vi.getTimerCount()).toBe(1);
    await act(async()=>vi.advanceTimersByTime(60_000));
    expect(allNodes(host).find(node=>node.tagName==="TIME")).toBe(time);expect(time?.textContent).toContain("4 min");expect(renders).toBe(1);
  }finally{await act(async()=>root.unmount());}
  expect(vi.getTimerCount()).toBe(0);
});
