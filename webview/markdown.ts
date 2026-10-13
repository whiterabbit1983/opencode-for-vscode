import { marked, type Tokens } from "marked";

/**
 * Markdown rendering for the chat transcript.
 *
 * Raw HTML in model output is escaped rather than rendered, links are limited
 * to safe schemes, and code blocks get lightweight theme-aware highlighting.
 */

const SAFE_SCHEME = /^(https?:|mailto:|vscode:|command:|file:|#)/i;

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.raw);
    },
    link(token: Tokens.Link) {
      const href = sanitizeUrl(token.href);
      const text = this.parser.parseInline(token.tokens ?? []);
      if (!href) {
        return text;
      }
      return `<a href="${escapeHtml(href)}" data-external="true" rel="noopener noreferrer">${text}</a>`;
    },
    image(token: Tokens.Image) {
      const href = sanitizeUrl(token.href);
      const alt = escapeHtml(token.text ?? "");
      if (!href) {
        return alt;
      }
      return `<img src="${escapeHtml(href)}" alt="${alt}" loading="lazy" />`;
    },
    code(token: Tokens.Code) {
      return renderCodeBlock(token.text, token.lang ?? "");
    },
  },
});

export function renderMarkdown(source: string): string {
  if (!source) {
    return "";
  }
  return marked.parse(source, { async: false }) as string;
}

/** Renders a single line of text without any block-level markdown. */
export function renderInline(source: string): string {
  return marked.parseInline(source, { async: false }) as string;
}

/* ------------------------------------------------------------------ */
/* Code blocks                                                          */
/* ------------------------------------------------------------------ */

export function renderCodeBlock(code: string, lang: string): string {
  const language = (lang ?? "").split(/\s+/)[0].toLowerCase();
  const highlighted = highlight(code, language);
  const label = language || "text";
  return (
    `<div class="code-block">` +
    `<div class="code-head"><span class="lang">${escapeHtml(label)}</span>` +
    `<button class="code-copy" type="button" title="Copy code">` +
    `<span class="codicon codicon-copy"></span>Copy</button></div>` +
    `<pre><code>${highlighted}</code></pre></div>`
  );
}

const COMMON_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from", "function", "get", "if",
  "implements", "import", "in", "instanceof", "interface", "is", "keyof", "let", "namespace", "new", "of",
  "package", "private", "protected", "public", "readonly", "return", "satisfies", "set", "static", "super",
  "switch", "this", "throw", "try", "type", "typeof", "var", "void", "while", "with", "yield",
  "def", "elif", "except", "lambda", "pass", "raise", "self", "None", "True", "False", "and", "or", "not",
  "fn", "mut", "pub", "impl", "trait", "match", "use", "mod", "struct", "where", "loop", "move", "ref",
  "echo", "cd", "ls", "cat", "grep", "sed", "awk", "find", "xargs", "mkdir", "rm", "cp", "mv", "export",
  "local", "then", "fi", "esac", "source", "function", "select", "insert", "update", "delete", "where",
  "group", "order", "by", "join", "union", "table", "create", "alter", "index", "view", "begin", "commit",
]);

interface LanguageSpec {
  lineComment?: string;
  blockComment?: [string, string];
  strings: string[];
  keywords?: Set<string>;
  markup?: boolean;
}

const SPECS: Record<string, LanguageSpec> = {
  python: { lineComment: "#", strings: ['"""', "'''", '"', "'"] },
  py: { lineComment: "#", strings: ['"""', "'''", '"', "'"] },
  bash: { lineComment: "#", strings: ['"', "'"] },
  sh: { lineComment: "#", strings: ['"', "'"] },
  shell: { lineComment: "#", strings: ['"', "'"] },
  zsh: { lineComment: "#", strings: ['"', "'"] },
  yaml: { lineComment: "#", strings: ['"', "'"] },
  yml: { lineComment: "#", strings: ['"', "'"] },
  toml: { lineComment: "#", strings: ['"', "'"] },
  ini: { lineComment: "#", strings: ['"', "'"] },
  ruby: { lineComment: "#", strings: ['"', "'"] },
  rb: { lineComment: "#", strings: ['"', "'"] },
  perl: { lineComment: "#", strings: ['"', "'"] },
  r: { lineComment: "#", strings: ['"', "'"] },
  go: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "`"] },
  rust: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  rs: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  c: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  cpp: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  csharp: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  cs: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  java: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  kotlin: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  swift: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  javascript: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  js: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  jsx: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  typescript: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  ts: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  tsx: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  php: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'"] },
  scala: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  dart: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'"] },
  sql: { lineComment: "--", strings: ["'", '"'] },
  lua: { lineComment: "--", blockComment: ["--[[", "]]"], strings: ['"', "'"] },
  haskell: { lineComment: "--", strings: ['"'] },
  elixir: { lineComment: "#", strings: ['"', "'"] },
  erlang: { lineComment: "%", strings: ['"'] },
  lisp: { lineComment: ";", strings: ['"'] },
  clojure: { lineComment: ";", strings: ['"'] },
  css: { blockComment: ["/*", "*/"], strings: ['"', "'"] },
  scss: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'"] },
  less: { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'"] },
  html: { strings: ['"', "'"], markup: true },
  xml: { strings: ['"', "'"], markup: true },
  svg: { strings: ['"', "'"], markup: true },
  json: { strings: ['"'] },
  jsonc: { lineComment: "//", strings: ['"'] },
  yaml_frontmatter: { lineComment: "#", strings: ['"', "'"] },
  dockerfile: { lineComment: "#", strings: ['"', "'"] },
  makefile: { lineComment: "#", strings: ['"', "'"] },
  gradle: { lineComment: "//", strings: ['"', "'"] },
};

const DEFAULT_SPEC: LanguageSpec = { lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] };

const regexCache = new Map<string, RegExp>();

function buildRegex(spec: LanguageSpec): RegExp {
  const alternatives: string[] = [];
  if (spec.blockComment) {
    alternatives.push(escapeRegex(spec.blockComment[0]) + `[\\s\\S]*?${escapeRegex(spec.blockComment[1])}`);
  }
  if (spec.lineComment) {
    alternatives.push(`${escapeRegex(spec.lineComment)}[^\\n]*`);
  }
  for (const quote of spec.strings) {
    alternatives.push(`${escapeRegex(quote)}(?:\\\\.|[^\\\\\\n])*?${escapeRegex(quote)}`);
    alternatives.push(`${escapeRegex(quote)}[^\\n]*?${escapeRegex(quote)}`);
  }
  alternatives.push("\\b0[xXbBoO][0-9a-fA-F_]+\\b", "\\b\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?\\b");
  alternatives.push("</?[A-Za-z][\\w:-]*", "\\b[A-Za-z_$][\\w$]*(?=\\()");
  alternatives.push("\\b[A-Za-z_$][\\w$-]*\\b");
  return new RegExp(alternatives.join("|"), "g");
}

function specFor(lang: string): LanguageSpec {
  return SPECS[lang] ?? (lang === "html" || lang === "xml" ? SPECS.html! : DEFAULT_SPEC);
}

/**
 * A deliberately small highlighter: enough colour to scan code quickly without
 * shipping a full grammar engine into the webview.
 */
export function highlight(code: string, lang: string): string {
  const spec = specFor(lang);
  if (!code) {
    return "";
  }

  let regex = regexCache.get(lang);
  if (!regex) {
    regex = buildRegex(spec);
    regexCache.set(lang, regex);
  }

  const keywords = spec.keywords ?? COMMON_KEYWORDS;
  let out = "";
  let last = 0;

  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code)) !== null) {
    if (match.index > last) {
      out += escapeHtml(code.slice(last, match.index));
    }
    out += `<span class="${classify(match[0], spec, keywords)}">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
    if (match[0].length === 0) {
      regex.lastIndex++;
    }
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function classify(token: string, spec: LanguageSpec, keywords: Set<string>): string {
  if (spec.blockComment && token.startsWith(spec.blockComment[0])) {
    return "tok-comment";
  }
  if (spec.lineComment && token.startsWith(spec.lineComment)) {
    return "tok-comment";
  }
  if (spec.strings.some((quote) => token.startsWith(quote))) {
    return "tok-string";
  }
  if (/^0[xXbBoO]/.test(token) || /^\d/.test(token)) {
    return "tok-number";
  }
  if (spec.markup) {
    if (/^<\/?[A-Za-z]/.test(token)) {
      return "tok-tag";
    }
    return "tok-attr";
  }
  if (/^[A-Za-z_$][\w$]*$/.test(token)) {
    if (token.endsWith("(")) {
      return "tok-function";
    }
    if (keywords.has(token) || /^(const|let|var|def|fn|func|class|struct|enum|interface|import|export|require)$/.test(token)) {
      return "tok-keyword";
    }
    return "tok-string";
  }
  return "tok-string";
}

/* ------------------------------------------------------------------ */
/* Escaping                                                             */
/* ------------------------------------------------------------------ */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sanitizeUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  const trimmed = url.trim();
  if (trimmed.startsWith("#")) {
    return trimmed;
  }
  if (SAFE_SCHEME.test(trimmed)) {
    return trimmed;
  }
  // Relative links inside the transcript are not useful and could escape the
  // webview origin, so they are dropped.
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}