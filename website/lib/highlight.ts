// A small build-time highlighter for bash, TypeScript and JSON.
// It only colours: comments, strings, keywords, numbers, flags, names.
// Anything it does not know is passed through, escaped.

import { escapeHtml } from "./text.ts";

type Rule = readonly [cls: string, re: RegExp];

const BASH: Rule[] = [
  ["c", /(?<=^|[\s;])#[^\n]*/y],
  ["s", /'[^']*'|"(?:\\.|[^"\\])*"/y],
  ["v", /\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$[0-9@?#*]/y],
  ["k", /\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|export|alias|return)\b/y],
  ["fn", /(?<=(?:^|\n|&&|\|\||\||;|\$\()[ \t]*)[A-Za-z_.~\/][\w.\/~-]*/y],
  ["f", /(?<=\s)--?[A-Za-z0-9][\w-]*/y],
];

const TS: Rule[] = [
  ["c", /\/\/[^\n]*|\/\*[\s\S]*?\*\//y],
  ["s", /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/y],
  [
    "k",
    /\b(?:import|from|export|default|const|let|var|function|return|if|else|for|while|async|await|new|type|interface|extends|implements|class|of|in|as|throw|try|catch|typeof|keyof|readonly|null|undefined|true|false|void)\b/y,
  ],
  ["n", /\b\d[\d_]*(?:\.\d+)?\b/y],
  ["t", /\b[A-Z][A-Za-z0-9_]*\b/y],
  ["fn", /\b[a-zA-Z_$][\w$]*(?=\()/y],
];

const JSON_RULES: Rule[] = [
  ["p", /"(?:\\.|[^"\\\n])*"(?=\s*:)/y],
  ["s", /"(?:\\.|[^"\\\n])*"/y],
  ["n", /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
  ["k", /\b(?:true|false|null)\b/y],
];

const LANGS: Record<string, Rule[]> = {
  bash: BASH, sh: BASH, shell: BASH, zsh: BASH, console: BASH,
  ts: TS, typescript: TS, js: TS, javascript: TS, tsx: TS, jsx: TS, mjs: TS,
  json: JSON_RULES, jsonc: JSON_RULES, jsonl: JSON_RULES,
};

const FALLBACK = /[A-Za-z0-9_$]+|[\s\S]/y;

export const canHighlight = (lang: string | undefined): boolean => !!lang && lang.toLowerCase() in LANGS;

/** Returns escaped HTML; spans carry classes `tk-<cls>`. */
export function highlight(code: string, lang: string | undefined): string {
  const rules = lang ? LANGS[lang.toLowerCase()] : undefined;
  if (!rules) return escapeHtml(code);
  let out = "";
  let i = 0;
  while (i < code.length) {
    let matched = false;
    for (const [cls, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m[0].length > 0) {
        out += `<span class="tk-${cls}">${escapeHtml(m[0])}</span>`;
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    FALLBACK.lastIndex = i;
    const m = FALLBACK.exec(code);
    const chunk = m ? m[0] : code[i] ?? "";
    out += escapeHtml(chunk);
    i += chunk.length || 1;
  }
  return out;
}
