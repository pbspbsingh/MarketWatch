import { useMemo } from "react";

interface Heading {
  level: number;
  sourcePosition: string;
  title: string;
}

export function DailyNoteContents({
  html,
  onSelect,
}: {
  html: string;
  onSelect: (sourcePosition: string) => void;
}) {
  const headings = useMemo(() => extractHeadings(html), [html]);

  return (
    <aside className="daily-note-contents">
      <header>Contents</header>
      {headings.length === 0 ? (
        <span className="daily-note-contents-empty">No headings</span>
      ) : (
        <nav aria-label="Note contents">
          {headings.map((heading) => (
            <button
              key={heading.sourcePosition}
              type="button"
              data-level={heading.level}
              title={heading.title}
              onClick={() => onSelect(heading.sourcePosition)}
            >
              {heading.title}
            </button>
          ))}
        </nav>
      )}
    </aside>
  );
}

function extractHeadings(html: string): Heading[] {
  const document = new DOMParser().parseFromString(html, "text/html");
  return [...document.querySelectorAll<HTMLElement>("h1[data-sourcepos], h2[data-sourcepos], h3[data-sourcepos]")]
    .map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      sourcePosition: heading.dataset.sourcepos ?? "",
      title: heading.textContent?.trim() ?? "",
    }))
    .filter((heading) => heading.sourcePosition !== "" && heading.title !== "");
}
