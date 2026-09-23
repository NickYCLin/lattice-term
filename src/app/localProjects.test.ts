import { describe, expect, it } from "vitest";
import { LOCAL_PROJECTS_KEY, parseLocalProjects, updateLocalProjects } from "./localProjects";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}
describe("independent project catalog", () => {
  it("retains empty projects across restart and removes only explicit entries", () => {
    const db = storage();
    updateLocalProjects(db, ["D:\\work\\one", "D:\\work\\two"]);
    updateLocalProjects(db, []);
    expect(parseLocalProjects(db.getItem(LOCAL_PROJECTS_KEY))).toHaveLength(2);
    expect(updateLocalProjects(db, ["d:/WORK/one/"])).toHaveLength(2);
    expect(updateLocalProjects(db, [], "d:/work/one")).toEqual(["D:\\work\\two"]);
  });
  it("preserves case-sensitive Unix projects and unreadable data", () => {
    const db = storage();
    expect(updateLocalProjects(db, ["/work/A", "/work/a"])).toHaveLength(2);
    db.setItem(LOCAL_PROJECTS_KEY, "broken");
    expect(() => updateLocalProjects(db, [])).toThrow();
    expect(db.getItem(LOCAL_PROJECTS_KEY)).toBe("broken");
  });
  it("does not overwrite external changes or invalid paths", () => {
    const db = storage();
    expect(() => updateLocalProjects(db, ["bad\npath"])).toThrow();
    let reads = 0;
    expect(() => updateLocalProjects({
      getItem: () => ++reads === 1 ? null : '{"version":1,"directories":["/other"]}',
      setItem: () => { throw new Error("must not write"); },
    }, ["/new"])).toThrow("changed");
  });
});
