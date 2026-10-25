import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import githubDark from 'shiki/themes/github-dark.mjs';
import githubLight from 'shiki/themes/github-light.mjs';
import { useEffect, useState } from 'react';

let highlighter: Promise<HighlighterCore> | undefined;

function getHighlighter() {
  highlighter ??= createHighlighterCore({
    themes: [githubLight, githubDark],
    langs: [c, cpp],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

export type ThemeKind = 'light' | 'dark';

function currentTheme(): ThemeKind {
  const cl = document.body.classList;
  if (cl.contains('vscode-light') || cl.contains('vscode-high-contrast-light')) return 'light';
  if (cl.contains('vscode-dark') || cl.contains('vscode-high-contrast')) return 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Tracks VS Code's theme kind, which it signals through classes on <body>. */
export function useThemeKind(): ThemeKind {
  const [kind, setKind] = useState(currentTheme);
  useEffect(() => {
    const obs = new MutationObserver(() => setKind(currentTheme()));
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return kind;
}

export function useTokens(
  code: string | undefined,
  lang: 'c' | 'cpp',
): ThemedToken[][] | undefined {
  const theme = useThemeKind();
  const [tokens, setTokens] = useState<ThemedToken[][]>();
  useEffect(() => {
    setTokens(undefined);
    if (code === undefined) return;
    let cancelled = false;
    getHighlighter()
      .then((h) =>
        h.codeToTokensBase(code, {
          lang,
          theme: theme === 'dark' ? 'github-dark' : 'github-light',
        }),
      )
      .then(
        (t) => !cancelled && setTokens(t),
        () => undefined,
      );
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);
  return tokens;
}
