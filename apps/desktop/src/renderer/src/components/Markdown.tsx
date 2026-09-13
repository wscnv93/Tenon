import { memo, useMemo } from "react";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

const cache = new Map<string, string>();

function render(markdown: string): string {
  const hit = cache.get(markdown);
  if (hit !== undefined) return hit;
  // TODO(M1): shiki streaming syntax highlight + worker-based parsing +
  // DOMPurify sanitization. Local agent output only for now.
  let html: string;
  try {
    html = marked.parse(markdown) as string;
  } catch {
    html = `<p>${markdown}</p>`;
  }
  if (cache.size > 500) cache.clear();
  cache.set(markdown, html);
  return html;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => render(text), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});
