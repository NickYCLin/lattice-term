import { describe, expect, it } from "vitest";
import { chatProjectKey, chatProjects, chatProjectsWithHistory, projectName } from "./chatProjects";

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

  it("treats a Windows verbatim path as the same folder", () => {
    const projects = chatProjects([
      { workingDirectory: "D:\\project\\FaceSpeak", updatedAt: 1 },
      { workingDirectory: "\\\\?\\D:\\project\\FaceSpeak", updatedAt: 2 },
    ]);
    expect(projects).toEqual([{ directory: "D:\\project\\FaceSpeak", name: "FaceSpeak", threads: 2, updatedAt: 2 }]);
    expect(chatProjectKey("\\\\?\\UNC\\server\\share\\app\\")).toBe("\\\\server\\share\\app");
  });

  it("adds folders that only hold CLI conversations, once each", () => {
    const projects = chatProjectsWithHistory(
      [{ workingDirectory: "D:\\project\\LatticeTerm", updatedAt: 5_000, definitionId: "codex",
        accountProfileId: null, nativeSessionId: "opened" }],
      [
        { definitionId: "codex", profileId: null, nativeSessionId: "opened",
          workingDirectory: "\\\\?\\D:\\project\\LatticeTerm", updatedAt: 9 },
        { definitionId: "codex", profileId: null, nativeSessionId: "face",
          workingDirectory: "\\\\?\\D:\\project\\FaceSpeak", updatedAt: 7 },
        { definitionId: "codex", profileId: null, nativeSessionId: "old",
          workingDirectory: "D:\\project\\Old", updatedAt: 8, archived: true },
      ],
    );
    expect(projects.map((project) => [project.name, project.threads, project.updatedAt])).toEqual([
      ["FaceSpeak", 1, 7_000],
      ["LatticeTerm", 1, 5_000],
    ]);
  });

  it("names a project after its last folder", () => {
    expect(projectName("C:\\\\code\\\\site\\\\")).toBe("site");
    expect(projectName("/")).toBe("/");
  });
});
