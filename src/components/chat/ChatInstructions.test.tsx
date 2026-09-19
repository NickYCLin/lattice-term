import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../i18n";
import { ChatInstructions } from "./ChatInstructions";

describe("chat instructions", () => {
  it("offers the shared rules editor only when the conversation has a folder", () => {
    const render = (workingDirectory: string) =>
      renderToStaticMarkup(
        <I18nProvider locale="en">
          <ChatInstructions definitionId="claude" workingDirectory={workingDirectory} configDirectory={null} />
        </I18nProvider>,
      );
    expect(render("/work")).toContain("Instructions &amp; memory");
    expect(render("/work")).toContain("Edit shared project rules");
    expect(render("")).not.toContain("Edit shared project rules");
  });
});
