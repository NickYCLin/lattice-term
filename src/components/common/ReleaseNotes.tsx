/**
 * The release body, rendered as what it describes: a few headed lists of
 * changes.  Falls back to the original text when the notes are not shaped
 * like that, so an unusual release never shows an empty box.
 */
import { parseReleaseNotes } from "../../app/releaseNotes";

export function ReleaseNotes({ body }: { body: string }) {
  const sections = parseReleaseNotes(body);
  if (sections.length === 0) {
    return <p className="release-notes__paragraph">{body.trim()}</p>;
  }

  return (
    <div className="release-notes">
      {sections.map((section, index) => (
        <section key={section.title ?? `section-${index}`}>
          {section.title && <h4 className="release-notes__title">{section.title}</h4>}
          {section.paragraphs.map((paragraph) => (
            <p className="release-notes__paragraph" key={paragraph}>
              {paragraph}
            </p>
          ))}
          {section.items.length > 0 && (
            <ul className="release-notes__list">
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
