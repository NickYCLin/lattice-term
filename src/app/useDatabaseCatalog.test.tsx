import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { emptyDatabase, type DatabaseSnapshot } from "../domain/database";
import { useDatabaseCatalog } from "./useDatabaseCatalog";
const invoke=vi.hoisted(()=>vi.fn());
vi.mock("@tauri-apps/api/core",()=>({invoke}));
it("loads metadata without sessions, keeps the last list on error and discards stale replies",async()=>{
  const container=installFakeDom();const root=createRoot(container as unknown as Element);
  let api!:ReturnType<typeof useDatabaseCatalog>;
  function Harness({enabled,revision}:{enabled:boolean;revision:number}){api=useDatabaseCatalog(enabled,revision);return null;}
  const profile={...emptyDatabase("local"),name:"獨立資料庫"};
  const snapshot:DatabaseSnapshot={profiles:[profile],revision:"one",credentialCleanupPending:0};
  invoke.mockResolvedValue(snapshot);
  const render=async(enabled:boolean,revision=0)=>{await act(async()=>root.render(<Harness enabled={enabled} revision={revision}/>));};
  try{
    await render(false);expect(invoke).not.toHaveBeenCalled();
    await render(true);expect(api.profiles).toEqual([profile]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("database_profiles");
    invoke.mockRejectedValueOnce(Error("metadata unavailable"));
    await act(async()=>api.refresh());expect(api.error).toContain("metadata unavailable");expect(api.profiles).toEqual([profile]);
    let finish!:(value:DatabaseSnapshot)=>void;
    invoke.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await render(true,1);await render(false,1);
    await act(async()=>finish(snapshot));expect(api.profiles).toEqual([]);
    expect(invoke.mock.calls.every(([command])=>command==="database_profiles")).toBe(true);
  }finally{await act(async()=>root.unmount());invoke.mockReset();}
});
