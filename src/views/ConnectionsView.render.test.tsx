/**
 * Static renders of the connections page: an empty workspace offers a way
 * to start, and a populated one lists the profile with its connect action.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../app/useWorkspace";
import type { ConnectionProfile } from "../domain/connection";
import { I18nProvider } from "../i18n";
import { ConnectionsView } from "./ConnectionsView";

const profile: ConnectionProfile = {
  id: "p1",
  name: "資料庫跳板",
  protocol: "ssh",
  hostname: "bastion.example.com",
  username: "ops",
  port: 22,
  environment: "production",
  group: "",
  tags: ["db"],
  favorite: false,
};

/** Only the fields the view destructures; the hook's other members are unused here. */
function workspaceWith(profiles: ConnectionProfile[]): Workspace {
  const partial = {
    profiles,
    visibleGroups: profiles.length ? [{ name: "", profiles }] : [],
    visibleProfiles: profiles,
    filterActive: false,
    sortOrder: "name",
    setSortOrder: vi.fn(),
    resetFilter: vi.fn(),
    selectedId: null,
    setSelectedId: vi.fn(),
    duplicateProfile: vi.fn(),
    toggleFavorite: vi.fn(),
    loadSamples: vi.fn(),
    importProfiles: vi.fn(async () => ({ count: 0, error: null })),
  };
  return partial as unknown as Workspace;
}

function render(profiles: ConnectionProfile[]): string {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <ConnectionsView
        workspace={workspaceWith(profiles)}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onConnect={vi.fn()}
        supportedProtocols={["ssh", "sftp"]}
        backendAvailable
        mobile={false}
      />
    </I18nProvider>,
  );
}

describe("ConnectionsView", () => {
  it("offers a way to start when the workspace is empty", () => {
    const markup = render([]);
    expect(markup).toContain("還沒有任何連線");
    expect(markup).toContain("新增連線");
    expect(markup).toContain("載入範例");
  });

  it("lists a saved profile by name and host", () => {
    const markup = render([profile]);
    expect(markup).toContain("資料庫跳板");
    expect(markup).toContain("bastion.example.com");
    expect(markup).not.toContain("還沒有任何連線");
  });

  it("renders expanded native groups that can be collapsed with the keyboard", () => {
    const markup = render([profile]);
    expect(markup).toContain('<details class="connection-group" open="">');
    expect(markup).toContain('<summary class="connection-group__title">');
    expect(markup).toContain('class="connection-group__count">1</span>');
  });

  it("does not show an empty group left behind by folded machine routes", () => {
    const profiles = [
      { ...profile, group: "第一組", machineId: "same-machine" },
      { ...profile, id: "p2", group: "第二組", machineId: "same-machine" },
    ];
    const workspace = workspaceWith(profiles);
    workspace.visibleGroups = profiles.map((entry) => ({
      name: entry.group,
      profiles: [entry],
    }));
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <ConnectionsView
          workspace={workspace}
          onCreate={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onConnect={vi.fn()}
          supportedProtocols={["ssh"]}
          backendAvailable
          mobile={false}
        />
      </I18nProvider>,
    );
    expect(markup.match(/<details /g)).toHaveLength(1);
    expect(markup).toContain("第一組");
    expect(markup).not.toContain("第二組");
  });
});
