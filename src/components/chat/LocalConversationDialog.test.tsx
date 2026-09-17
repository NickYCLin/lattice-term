import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fakeAgentApi, fakeChatApi, fakeThread } from "../../app/testFixtures/agentApis";
import { I18nProvider } from "../../i18n";
import { LocalConversationDialog } from "./LocalConversationDialog";

describe("external conversations dialog", () => {
  it("distinguishes local continuation from cloud export and original apps", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <LocalConversationDialog agents={fakeAgentApi()} chat={fakeChatApi()}
          onClose={() => {}} onOpenChat={() => {}} onOpenSession={() => {}} />
      </I18nProvider>,
    );
    expect(html).toContain("Continue in Sessions");
    expect(html).toContain("Continue in Chat");
    expect(html).toContain("conversations.json");
    expect(html).toContain("https://chatgpt.com/codex");
    expect(html).toContain("https://claude.ai/");
  });

  it("shows an imported cloud archive in the shared Sessions and Chat history", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <LocalConversationDialog agents={fakeAgentApi()}
          chat={fakeChatApi({ threads: [fakeThread({ title: "Saved cloud chat", archived: true })] })}
          onClose={() => {}} onOpenChat={() => {}} onOpenSession={() => {}} />
      </I18nProvider>,
    );
    expect(html).toContain("Saved cloud chat");
    expect(html).toContain("Read-only export");
  });
});
