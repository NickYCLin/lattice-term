/**
 * Static renders of the tunnels page: the empty state with its type
 * filters, the desktop-only notice when there is no backend (configuring
 * stays possible, starting does not), and the add button being tied to
 * having an SSH profile to tunnel through.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../domain/connection";
import { I18nProvider } from "../i18n";
import { TunnelsView } from "./TunnelsView";

afterEach(() => vi.unstubAllGlobals());

const sshProfile: ConnectionProfile = {
  id: "p1",
  name: "bastion",
  protocol: "ssh",
  hostname: "bastion.example.com",
  username: "ops",
  port: 22,
  environment: "production",
  group: "",
  tags: [],
  favorite: false,
};

function render(profiles: ConnectionProfile[], backendAvailable: boolean): string {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <TunnelsView profiles={profiles} backendAvailable={backendAvailable} />
    </I18nProvider>,
  );
}

describe("TunnelsView", () => {
  it("explains unreadable storage and disables both add buttons", () => {
    vi.stubGlobal("localStorage", { getItem: () => "[null]" });
    const markup = render([sshProfile], true);
    expect(markup).toContain("無法讀取通道設定");
    expect(markup).toContain("原有資料未被覆蓋");
    const addButtons = markup.split("</button>").map(part => part.slice(part.lastIndexOf("<button")))
      .filter(button => button.startsWith("<button") && button.includes("新增通道"));
    expect(addButtons).toHaveLength(2);
    expect(addButtons.every(button => button.slice(button.lastIndexOf("<button")).includes('disabled=""'))).toBe(true);
  });
  it("shows the empty state with every tunnel type filter", () => {
    const markup = render([sshProfile], true);
    expect(markup).toContain("尚無任何通道設定");
    expect(markup).toContain("本機轉送 (-L)");
    expect(markup).toContain("遠端轉送 (-R)");
    expect(markup).toContain("動態代理 (-D)");
  });

  it("without a backend still allows configuring but not starting", () => {
    const markup = render([sshProfile], false);
    expect(markup).toContain("通道執行需要桌面後端");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*全部啟動/s);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*新增通道/s);
  });

  it("cannot add a tunnel without an SSH profile to go through", () => {
    const markup = render([{ ...sshProfile, protocol: "rdp", port: 3389 }], true);
    expect(markup).not.toContain("通道執行需要桌面後端");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*新增通道/s);
  });
});
