import { expect, it } from "vitest";
import { projectDirectoryKey as key, localProjectId, disambiguateProjectLabels } from "./projectDirectory";
import { chatProjectKey } from "./chatProjects";
import { agentWorkspaceProjectNodeId } from "./chatWorkspaceNodes";
import { projectDirectoryKey as catalogKey } from "./localProjects";
it.each([
  ["/work/rust/", "/work/rust"], ["/work//rust///", "/work/rust"], ["/", "/"],
  ["C:\\Work\\Frontend\\", "c:/work/frontend"], ["c:/WORK/frontend/", "c:/work/frontend"],
  ["\\\\?\\C:\\Work\\Frontend\\", "c:/work/frontend"], ["//?/C:/Work/frontend/", "c:/work/frontend"],
  ["C:\\", "c:/"], ["c:/", "c:/"], ["C:", "C:"],
  ["\\\\?\\UNC\\SERVER\\Share\\App\\", "//server/share/app"], ["\\\\Server\\Share\\App", "//server/share/app"],
  ["//server/share/app/", "//server/share/app"],
  ["\\\\wsl$\\Ubuntu\\home\\User\\App\\", "//wsl.localhost/ubuntu/home/User/App"],
  ["//wsl.localhost/UBUNTU/home/User/App/", "//wsl.localhost/ubuntu/home/User/App"],
])("uses one identity across chat, sessions and catalog: %s", (path, expected) => {
  expect(key(path)).toBe(expected);
  expect(chatProjectKey(path)).toBe(expected);
  expect(catalogKey(path)).toBe(expected);
  expect(agentWorkspaceProjectNodeId(path)).toBe(`project:${localProjectId(path)}`);
});
it.each([
  ["/work/Frontend", "/work/frontend"], ["/a/rust", "/b/rust"], ["C:", "C:/"],
  ["//wsl$/ubuntu/home/User", "//wsl$/ubuntu/home/user"],
  ["/mnt/c/work", "C:/work"], ["/home/user", "/data/user/home"],
  ["/work/with space ", "/work/with space"], ["/a/link/../x", "/a/x"],
])("never guesses that distinct or unverified paths match: %s / %s", (a, b) => expect(key(a)).not.toBe(key(b)));
it("shows different parents for duplicate labels without merging projects", () => {
  const result = disambiguateProjectLabels([
    { id: "a", label: "rust", workingDirectory: "/one/rust" }, { id: "b", label: "rust", workingDirectory: "/two/rust" },
    { id: "c", label: "frontend", workingDirectory: "/one/frontend" },
  ]);
  expect(result.map(p => p.label)).toEqual(["rust · /one", "rust · /two", "frontend"]);
});
it("uses short unique parent suffixes so shared long prefixes do not hide the distinction", () => {
  const result = disambiguateProjectLabels([
    { id: "a", label: "rust", workingDirectory: "/long/common/path/team-a/src/rust" },
    { id: "b", label: "rust", workingDirectory: "/long/common/path/team-b/src/rust" },
  ]);
  expect(result.map(project => project.label)).toEqual(["rust · …/team-a/src", "rust · …/team-b/src"]);
});
