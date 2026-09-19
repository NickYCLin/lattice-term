import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../i18n";
import { elicitationAnswer, McpElicitation, parseElicitation } from "./McpElicitation";

const form = JSON.stringify({
  mode: "form",
  serverName: "github",
  message: "Which repository?",
  requestedSchema: {
    type: "object",
    properties: {
      repo: { type: "string", title: "Repository" },
      branch: { type: "string", enum: ["main", "dev"], enumNames: ["Main", "Development"] },
      depth: { type: "integer", default: 5 },
      force: { type: "boolean" },
    },
    required: ["repo"],
  },
});

describe("MCP elicitation", () => {
  it("reads a form into typed fields", () => {
    const request = parseElicitation(form)!;
    expect(request.serverName).toBe("github");
    expect(request.fields.map((field) => [field.name, field.kind, field.required])).toEqual([
      ["repo", "string", true],
      ["branch", "string", false],
      ["depth", "integer", false],
      ["force", "boolean", false],
    ]);
    expect(request.fields[1].choices).toEqual([
      { value: "main", label: "Main" },
      { value: "dev", label: "Development" },
    ]);
  });

  it("turns drafts into typed answers and holds back an incomplete one", () => {
    const { fields } = parseElicitation(form)!;
    expect(elicitationAnswer(fields, { repo: "", depth: "5", force: "false" })).toEqual({
      invalid: "repo",
    });
    expect(elicitationAnswer(fields, { repo: "x", depth: "2.5", force: "false" })).toEqual({
      invalid: "depth",
    });
    expect(
      JSON.parse(
        JSON.stringify(
          (elicitationAnswer(fields, { repo: "lattice", branch: "dev", depth: "3", force: "true" }) as {
            content: object;
          }).content,
        ),
      ),
    ).toEqual({ repo: "lattice", branch: "dev", depth: 3, force: true });
  });

  it("keeps a server's odd field name as a plain key", () => {
    const { fields } = parseElicitation(
      JSON.stringify({
        mode: "form",
        requestedSchema: { type: "object", properties: { __proto__: { type: "string" } }, required: ["__proto__"] },
      }).replace('"properties":{}', '"properties":{"__proto__":{"type":"string"}}'),
    )!;
    const answer = elicitationAnswer(fields, JSON.parse('{"__proto__":"value"}')) as { content: object };
    expect(JSON.stringify(answer.content)).toBe('{"__proto__":"value"}');
  });

  it("only offers http(s) pages and shows where they lead", () => {
    expect(parseElicitation(JSON.stringify({ mode: "url", url: "javascript:alert(1)" }))).toBeNull();
    const request = parseElicitation(
      JSON.stringify({ mode: "url", url: "https://auth.example.com/login", message: "Sign in" }),
    )!;
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en">
        <McpElicitation request={request} onAnswer={async () => {}} />
      </I18nProvider>,
    );
    expect(markup).toContain("auth.example.com");
    expect(markup).toContain("Open page and continue");
  });

  it("refuses shapes it cannot draw", () => {
    expect(
      parseElicitation(
        JSON.stringify({
          mode: "form",
          requestedSchema: { type: "object", properties: { nested: { type: "object" } } },
        }),
      ),
    ).toBeNull();
    expect(parseElicitation("{not json")).toBeNull();
  });
});
