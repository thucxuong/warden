// Inline SVG: the logo, the favicon, small icons and the step-flow diagram.
// Colours come from the page's CSS (classes and currentColor), so they follow
// the light and dark theme.

const icon = (body: string, cls = "icon"): string =>
  `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const LOGO = `<svg class="logo" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false"><path class="logo-shield" d="M16 2.5 27.5 6.6v8.3c0 7-4.8 12.4-11.5 14.6C9.3 27.3 4.5 21.9 4.5 14.9V6.6z"/><path class="logo-check" d="m10.6 15.8 3.8 3.8 7.2-7.6" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.s{fill:#0b7d5a}.c{stroke:#fff}@media (prefers-color-scheme:dark){.s{fill:#3ecf8e}.c{stroke:#0b1210}}</style><path class="s" d="M16 2.5 27.5 6.6v8.3c0 7-4.8 12.4-11.5 14.6C9.3 27.3 4.5 21.9 4.5 14.9V6.6z"/><path class="c" d="m10.6 15.8 3.8 3.8 7.2-7.6" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
`;

export const ICONS = {
  flow: icon('<rect x="3" y="3.5" width="7" height="7" rx="1.5"/><rect x="14" y="13.5" width="7" height="7" rx="1.5"/><path d="M10 7h3.5a2 2 0 0 1 2 2v4.5"/>'),
  gate: icon('<path d="M12 3 19 6v5.2c0 4.4-2.9 8-7 9.8-4.1-1.8-7-5.4-7-9.8V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>'),
  heal: icon('<path d="M20 11A8 8 0 0 0 5.6 6.6L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.4 4.4L20 16"/><path d="M20 20v-4h-4"/>'),
  signoff: icon('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20.5c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/><path d="m15.5 11 2 2 4-4"/>'),
  branch: icon('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10"/><path d="M18 8c0 5-4 6-10.5 9.5"/>'),
  layers: icon('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
  tools: icon('<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M8.5 8V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2"/><path d="M3 13.5h18"/><path d="M12 12v3"/>'),
  chart: icon('<path d="M3 20.5h18"/><path d="M6 17v-5"/><path d="M11 17V6"/><path d="M16 17v-8"/><path d="M21 17v-3"/>'),
  clock: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  question: icon('<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z"/><path d="M10 9.8a2.1 2.1 0 1 1 3 1.9c-.6.3-1 .8-1 1.5v.3"/><path d="M12 16.2h.01"/>'),
  send: icon('<path d="M21.5 2.5 10.5 13.5"/><path d="m21.5 2.5-7 19-4-8-8-4z"/>'),
  upgrade: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 16.5v-9"/><path d="m8 11.5 4-4 4 4"/>'),
  agent: icon('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4.5V8"/><circle cx="12" cy="3.5" r="1"/><path d="M9 13.5v1"/><path d="M15 13.5v1"/><path d="M2 13v3"/><path d="M22 13v3"/>'),
  claim: icon('<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/>'),
  push: icon('<path d="M12 15V3.5"/><path d="m7 8.5 5-5 5 5"/><path d="M4 15v3.5A2 2 0 0 0 6 20.5h12a2 2 0 0 0 2-2V15"/>'),
  pencil: icon('<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  book: icon('<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3"/>'),
  arrowRight: icon('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>', "icon icon-sm"),
  arrowLeft: icon('<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>', "icon icon-sm"),
  search: icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', "icon icon-sm"),
  menu: icon('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>'),
  close: icon('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
  sun: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>', "icon icon-sm icon-sun"),
  moon: icon('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>', "icon icon-sm icon-moon"),
  edit: icon('<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16z"/>', "icon icon-sm"),
} as const;

export type IconName = keyof typeof ICONS;

export const GITHUB_MARK = `<svg class="icon icon-sm" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

type Node = { x: number; title: string; sub: string; gate?: boolean };

/** A centred label with a solid box behind it, so a line under it does not show between the words. */
const boxedLabel = (x: number, y: number, text: string): string => {
  const w = Math.round(text.length * 7.9 + 16); // 13px mono is about 7.8px a character
  return `<rect class="dg-label-bg" x="${x - w / 2}" y="${y - 15}" width="${w}" height="21" rx="5"/><text class="dg-label" x="${x}" y="${y}">${text}</text>`;
};

/** The feature template's steps, with the loops back, as a wide diagram. */
export function flowDiagram(): string {
  const y = 132;
  const w = 164;
  const h = 62;
  const nodes: Node[] = [
    { x: 16, title: "plan", sub: "agent" },
    { x: 210, title: "implement", sub: "agent" },
    { x: 404, title: "check", sub: "warden runs your checks", gate: true },
    { x: 598, title: "review", sub: "a second Claude reads it", gate: true },
    { x: 792, title: "ship", sub: "PR or merge" },
  ];
  const box = (n: Node, yy: number): string =>
    `<g class="dg-node${n.gate ? " dg-gate" : ""}"><rect x="${n.x}" y="${yy}" width="${w}" height="${h}" rx="12"/>` +
    `<text class="dg-title" x="${n.x + w / 2}" y="${yy + 27}">${n.title}</text>` +
    `<text class="dg-sub" x="${n.x + w / 2}" y="${yy + 47}">${n.sub}</text></g>`;
  const arrows = nodes.slice(0, -1).map((n, i) => {
    const next = nodes[i + 1]!;
    return `<path class="dg-edge" d="M${n.x + w + 2} ${y + h / 2}H${next.x - 4}" marker-end="url(#dg-ah)"/>`;
  });
  const fix: Node = { x: 404, title: "fix", sub: "fixer agent, own branch" };
  const fy = 262;
  return `<svg class="flow-svg" viewBox="0 0 972 340" role="img" aria-labelledby="flow-svg-t" focusable="false">
<title id="flow-svg-t">Steps of the feature template: plan, implement, check, review, ship. A check that fails because of the change goes back to implement. A check that fails because of the setup, or for an unclear reason, goes to the fixer, then is checked again. Blocking review findings go back to implement.</title>
<defs><marker id="dg-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="dg-ah" d="M0 0 10 5 0 10z"/></marker>
<marker id="dg-ah2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="dg-ah2" d="M0 0 10 5 0 10z"/></marker></defs>
<path class="dg-loop" d="M700 ${y - 2}C700 22 262 22 262 ${y - 6}" marker-end="url(#dg-ah2)"/>
${boxedLabel(481, 50, "review: blocking findings")}
<path class="dg-loop" d="M466 ${y - 2}C466 84 322 84 322 ${y - 6}" marker-end="url(#dg-ah2)"/>
${boxedLabel(394, 100, "check fails: CODE")}
${arrows.join("\n")}
<path class="dg-loop" d="M466 ${y + h + 2}V${fy - 6}" marker-end="url(#dg-ah2)"/>
<text class="dg-label dg-label-end" x="456" y="${(y + h + fy) / 2 + 4}">OPS or UNCLEAR</text>
<path class="dg-edge" d="M526 ${fy - 2}V${y + h + 6}" marker-end="url(#dg-ah)"/>
<text class="dg-label dg-label-start" x="536" y="${(y + h + fy) / 2 + 4}">check again</text>
${nodes.map((n) => box(n, y)).join("\n")}
${box(fix, fy)}
<text class="dg-legend" x="16" y="${fy + 20}"><tspan class="dg-key dg-key-gate">■</tspan> gate: warden runs it, not the agent</text>
</svg>`;
}
