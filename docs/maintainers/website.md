# Website

How the warden website is built, how to preview it, and how it is deployed.

The website is a static site: a landing page and one page per user doc. It is published with GitHub Pages at [thucxuong.github.io/warden](https://thucxuong.github.io/warden/). It is not the `warden site` dashboard that projects run (`plugins/warden/src/site/`); the two share nothing.

## What it is made of

| Path | What it is |
|---|---|
| `website/build.ts` | The build. Reads `README.md` and `docs/**/*.md`, writes `website/dist/`. |
| `website/serve.ts` | A local preview server for `website/dist/`. |
| `website/content/landing.ts` | The words on the landing page. |
| `website/content/svg.ts` | The logo, the icons and the step diagram, as inline SVG. |
| `website/lib/` | Markdown to HTML, the code highlighter, the page templates. |
| `website/assets/` | `site.css` and `site.js`, copied as they are. |
| `tests/unit/website.test.ts` | Builds the site into a temp folder and checks pages, links, anchors and the search index. |

The site uses Bun and Node built-ins only: no npm packages, no CDN, no web fonts, no external images. Markdown goes through `Bun.markdown`.

## What gets published

- `README.md` feeds the landing page; it is not a page of its own. Links to it go to the landing page.
- Every `docs/**/*.md` becomes a page: `docs/a/b.md` is `docs/a/b.html`, and a `README.md` is the folder's `index.html`.
- `docs/internal/` is never published. Links to it, and to any file outside `docs/` (plugin code, `CHANGELOG.md`), go to the file on GitHub.
- The sidebar follows the lists under each `##` heading of [docs/README.md](../README.md). A new doc that is not listed there shows up under "More". Add it to `docs/README.md` instead.
- Heading ids are GitHub-style slugs, the page title (H1) included, so `page.md#some-heading` links work on GitHub and on the site.
- The version comes from `package.json`.

## Where the landing copy lives

Edit `website/content/landing.ts` for the hero, the problem, the step list, the agents section and the closing call to action. Some parts come from the docs at build time, so they stay true:

| Landing section | Source |
|---|---|
| How warden fixes it | `README.md`, the bullets under "Why warden" |
| Key features | `README.md`, the bullets under "Key features" |
| Quick start, with what you need | `README.md`, the section "Quick start" |
| Built for agents | `docs/for-agents.md`, the section "The short version" |

The build fails if one of these sections is renamed. Keep the bullets in the `- **Title.** text` shape.

While the repo stays private, the quick start says you need read access to it, because `README.md` says so. When the repo goes public, see [Going public](#going-public).

## Build and preview

```bash
bun run site:build
bun run site:serve
```

`site:build` writes `website/dist/` (gitignored). `site:serve` serves it at `http://localhost:4321/`, and also under `/warden/` like GitHub Pages. Set `PORT` to use another port.

Links between pages are relative, so the site works under `/warden/` and at the root of a domain. `SITE_URL` (default `https://thucxuong.github.io/warden/`) is used only where a full address is needed: the sitemap, the canonical and Open Graph tags, and the 404 page.

Before a commit that touches the site, run:

```bash
bun test tests/unit/website.test.ts
bun run typecheck
```

## Deploy

`.github/workflows/pages.yml` builds the site and deploys it to GitHub Pages:

- on every push to `stable`, so the site matches the released plugin (step 7 of [Releasing](releasing.md) moves `stable`);
- by hand, from the Actions tab (`workflow_dispatch`).

The job skips while the repo stays private, and it deploys only from `stable`, so a run from `main` cannot publish unreleased docs. It builds with `SITE_PUBLIC=1`, which fails the build while a published page still calls the repo private (see [Going public](#going-public)).

One-time setup, once the repo is public:

1. **Settings > Pages > Source**: choose **GitHub Actions**. This creates the `github-pages` environment.
2. **Settings > Environments > github-pages > Deployment branches and tags**: add `stable`. By default only the default branch (`main`) may deploy, and the deploy step would fail on `stable`.
3. **Actions > pages > Run workflow**: under **Use workflow from**, pick `stable`.

## Going public

Before the repo is made public, and so before the site deploys, change every place that calls the repo private or says there is no license:

- [ ] Pick a license. Add a `LICENSE` file, set `license` in `plugins/warden/.claude-plugin/plugin.json`, and replace the "License" section of `README.md`. Then add a link to the license in the site footer (`website/lib/layout.ts`). The site invites people to install warden, so this comes first.
- [ ] `README.md`, "Quick start": the line on what you need. Drop the read-access part, or point to Installation.
- [ ] [Installation](../getting-started/installation.md): the last row of the prerequisites table, and the section on repo access (SSH and HTTPS checks).
- [ ] [docs/README.md](../README.md), "Getting started": the Installation line mentions repo access.
- [ ] [Maintainer overview](README.md), "Repo facts": the first line calls the repo private.
- [ ] [Reports](../concepts/reports.md): the sync needs write access, which public users do not have. Check that the README feature line still reads right.

To check, run `SITE_PUBLIC=1 bun run site:build`. It lists each line that still needs a change.

## See also

- [Releasing](releasing.md)
- [Contributing](contributing.md)
- [Maintainer overview](README.md)
