import { expect, it } from "vitest";
import { draggedOutside, workbenchWindowId } from "./sqlWorkbench";
it("recognizes only a validated SQL window id without booting an ordinary workspace",()=>{
  expect(workbenchWindowId("?database-workbench="+"a".repeat(32))).toBe("a".repeat(32));
  for (const value of ["", "?database-workbench=../main", "?database-workbench=other&x=1"]) expect(workbenchWindowId(value)).toBeNull();
});
it("detaches only after leaving the window bounds",()=>{
  expect(draggedOutside(400,300,1000,700)).toBe(false);
  for (const [x,y] of [[-1,0],[1001,0],[0,-1],[0,701]]) expect(draggedOutside(x,y,1000,700)).toBe(true);
});
