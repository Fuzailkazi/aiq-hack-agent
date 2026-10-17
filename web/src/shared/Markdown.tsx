/**
 * The small Markdown subset the AI writes in feedback: headings, bullet lists, paragraphs and **bold**.
 * Rendered as React nodes (never as HTML), so model output cannot inject markup.
 */
import type { ReactNode } from "react";

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one static string
      <strong key={i} className="text-aq-ink font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push(
        <p key={blocks.length} className="text-aq-sm text-aq-ink-soft">
          {inline(para.join(" "))}
        </p>,
      );
      para = [];
    }
    if (bullets.length) {
      blocks.push(
        <ul key={blocks.length} className="text-aq-sm text-aq-ink-soft flex list-disc flex-col gap-1 pl-4.5">
          {bullets.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items of one static string
            <li key={i}>{inline(b)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (heading) {
      flush();
      blocks.push(
        <h4 key={blocks.length} className="text-aq-sm text-aq-ink mt-1 font-semibold">
          {inline(heading[1])}
        </h4>,
      );
    } else if (bullet) {
      if (para.length) flush();
      bullets.push(bullet[1]);
    } else {
      if (bullets.length) flush();
      para.push(line);
    }
  }
  flush();
  return <div className="flex flex-col gap-2.5">{blocks}</div>;
}
