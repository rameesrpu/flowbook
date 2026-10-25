import MarkdownIt from 'markdown-it';
import { useMemo } from 'react';

// Raw HTML is disabled, so the rendered output contains only markdown-it's own tags.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => md.render(text), [text]);
  return <div className={`fb-md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function MarkdownInline({ text }: { text: string }) {
  const html = useMemo(() => md.renderInline(text), [text]);
  return <span className="fb-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
