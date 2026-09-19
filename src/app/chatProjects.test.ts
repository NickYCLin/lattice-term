import { describe, expect, it } from "vitest";
import { chatProjects, projectName } from "./chatProjects";

describe("chat projects", () => {
  it("groups conversations by folder, newest project first, ignoring shelved and folderless ones", () => {
    const projects = chatProjects([
      { workingDirectory: "/work/a", updatedAt: 1 },
      { workingDirectory: "/work/b", updatedAt: 5 },
      { workingDirectory: "/work/a/", updatedAt: 3 },
      { workingDirectory: "/work/a", updatedAt: 9, shelvedAt: 10 },
      { workingDirectory: "", updatedAt: 20 },
    ]);
    expect(projects.map((project) => [project.name, project.threads])).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
  });

  it("names a project after its last folder", () => {
    expect(projectName("C:\\\\code\\\\site\\\\")).toBe("site");
    expect(projectName("/")).toBe("/");
  });
});
