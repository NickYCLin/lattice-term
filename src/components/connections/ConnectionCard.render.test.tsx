import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createConnectionProfile,
  emptyDraft,
} from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { ConnectionCard } from "./ConnectionCard";

const profile = createConnectionProfile(
  {
    ...emptyDraft("rdp"),
    name: "Office PC",
    hostname: "desktop.example.com",
    username: "operator",
  },
  "rdp-card",
);

function renderCard(
  options: Pick<
    Parameters<typeof ConnectionCard>[0],
    "onConnect" | "unavailableReason" | "linked" | "onAddRoute"
  > & Partial<Pick<Parameters<typeof ConnectionCard>[0], "profile">>,
) {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <ConnectionCard
        profile={profile}
        selected={false}
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onToggleFavorite={vi.fn()}
        {...options}
      />
    </I18nProvider>,
  );
}

describe("connection card runtime capability", () => {
  it("shows every tag in a separate row after the management controls", () => {
    const tags = ["正式服務平台與維運環境的完整標籤", "service.example.com/" + "long-name".repeat(12), "第三個標籤"];
    const markup = renderCard({ profile: { ...profile, tags } });
    const tagsStart = markup.indexOf('class="connection-card__tags"');
    expect(tagsStart).toBeGreaterThan(markup.indexOf('class="connection-card__actions"'));
    const tagsMarkup = markup.slice(tagsStart);
    for (const tag of tags) expect(tagsMarkup).toContain(`>${tag}</span>`);
    expect(tagsMarkup.match(/badge--tag/g)).toHaveLength(3);
    expect(markup).not.toContain("connection-card__tag-count");
    expect(markup.slice(0, markup.indexOf('class="connection-card__primary"'))).not.toContain("badge--tag");
  });

  it("does not reserve a tag row for a connection without tags", () => {
    expect(renderCard({ profile: { ...profile, tags: [] } })).not.toContain('class="connection-card__tags"');
  });

  it("keeps same-protocol routes behind a single connect button", () => {
    const markup = renderCard({ onConnect: vi.fn(), linked: [{
      profile: { ...profile, id: "wan", hostname: "wan.example.com", port: 3390 }, onConnect: vi.fn(),
    }] });
    expect(markup).not.toContain("wan.example.com:3390");
    expect(markup.match(/>連線<\/button>/g)).toHaveLength(1);
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain("2 個連線方式");
    expect(markup.match(/class="badge tone-neutral"/g)).toHaveLength(1);
    expect(markup).not.toContain("connection-card__route-info");
    expect(markup).not.toContain("同一台電腦：Office PC");
  });
  it("separates the primary action from compact management controls", () => {
    const markup = renderCard({ onConnect: vi.fn() });
    expect(markup).toContain('class="connection-card__primary"');
    expect(markup).toContain('protocol-tile--sm');
    const footer = markup.slice(markup.indexOf('class="connection-card__foot"'));
    expect(footer).toContain("加入常用");
    expect(footer).not.toContain("connection-card__go");
    expect(markup).toContain('title="Office PC');
    expect(markup).toContain('title="operator@desktop.example.com:3389"');
  });

  it("offers the live action when the package supports the protocol", () => {
    const markup = renderCard({ onConnect: vi.fn() });

    expect(markup).toContain(">連線</button>");
    expect(markup).not.toContain("桌面版限定");
  });

  it("states the mobile boundary without calling it coming soon", () => {
    const markup = renderCard({ unavailableReason: "desktop-only" });

    expect(markup).toContain("連線 · 桌面版限定");
    expect(markup).toContain("只能由 LatticeTerm 桌面版開啟");
    expect(markup).not.toContain("即將推出");
    expect(markup).not.toContain("連線功能開發中");
  });
});
describe("same-computer card", () => {
  it("offers a separate add-route action even when the current protocol is unavailable", () => {
    const markup = renderCard({ onAddRoute: vi.fn(), unavailableReason: "desktop-only" });
    expect(markup).toContain("connection-card__add-route");
    expect(markup).toContain("新增連線方式</button>");
    const footer = markup.slice(markup.indexOf('class="connection-card__foot"'));
    expect(footer).toContain("connection-card__add-route");
    expect(footer.indexOf("connection-card__add-route")).toBeLessThan(footer.indexOf("connection-card__actions"));
    expect(markup).toContain("桌面版限定");
    expect(renderCard({})).not.toContain("connection-card__add-route");
  });

  it("summarizes routes without repeating their names on the card", () => {
    const remote = createConnectionProfile(
      { ...emptyDraft("lattice"), name: "蘋果筆電", deviceId: "008806370" },
      "remote-card",
    );
    const markup = renderCard({
      onConnect: vi.fn(),
      linked: [{ profile: remote, onConnect: vi.fn() }],
    });

    expect(markup).not.toContain("同一台電腦：蘋果筆電");
    expect(markup).not.toContain("connection-card__name truncate");
    expect(markup).not.toContain("connection-card__target mono truncate");
    expect(markup).not.toContain("connection-card__target truncate");
    expect(markup).toContain("2 個連線方式");
    expect(markup.match(/>連線<\/button>/g)).toHaveLength(1);
  });
});
