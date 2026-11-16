import { afterEach, expect, it, vi } from "vitest";
import { checkedRecentProjects, projectCandidates, readRecentProjects, recordRecentProject } from "./recentProjects";
afterEach(()=>vi.unstubAllGlobals());
it("sorts by actual use, canonicalizes aliases and disables missing folders without merging basenames",()=>{
  const rows = [{path:"/synthetic/alias/",at:30},{path:"/synthetic/real",at:20},{path:"/other/real",at:10},{path:"/synthetic/missing",at:5}];
  const checked = checkedRecentProjects(rows, [{path:rows[0].path,canonicalPath:"/synthetic/real"},{path:rows[1].path,canonicalPath:"/synthetic/real"},{path:rows[2].path,canonicalPath:"/other/real"},{path:rows[3].path,canonicalPath:null}]);
  expect(checked.map(row=>row.path)).toEqual([rows[0].path,rows[2].path,rows[3].path]);
  expect(checked[2].canonicalPath).toBeNull();
  expect(checkedRecentProjects(rows,[],"missing")).toHaveLength(1);
});
it("bounds recent choices and uses the existing Windows normalization",()=>{
  expect(projectCandidates([{path:"C:\\Work\\Example\\",at:1},{path:"c:/work/example",at:2}])).toHaveLength(1);
  expect(projectCandidates([{path:"\\\\?\\C:\\Work\\Example",at:1},{path:"c:/work/example",at:2}])).toHaveLength(1);
  const rows = Array.from({length:20},(_,i)=>({path:`/synthetic/project-${i}`,at:i+1}));
  expect(checkedRecentProjects(rows,rows.map(row=>({path:row.path,canonicalPath:row.path})))).toHaveLength(8);
});
it("keeps selected folders locally after clearing the conversation folder and tolerates corrupt storage",()=>{
  let saved = "invalid";
  vi.stubGlobal("localStorage",{getItem:()=>saved,setItem:(_key:string,value:string)=>{saved=value;}});
  expect(readRecentProjects()).toEqual([]);
  recordRecentProject("/synthetic/one",10);recordRecentProject("/synthetic/one/",20);recordRecentProject("",30);
  expect(readRecentProjects()).toEqual([{path:"/synthetic/one/",at:20}]);
});
