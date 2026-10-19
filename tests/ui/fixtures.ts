// Shared Playwright fixture: every spec fails on a console error, a page error, or a request that does not go to
// the site under test (design 7.3). `allowConsole` lists expected console errors (a 404 the page shows on purpose).
import { expect, test as base } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:4417";

export const test = base.extend<{ allowConsole: RegExp[]; guard: void }>({
  allowConsole: [[], { option: true }],
  guard: [
    async ({ page, allowConsole }, use) => {
      const problems: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error" && !allowConsole.some((re) => re.test(m.text()))) problems.push(`console: ${m.text()}`);
      });
      page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
      page.on("request", (r) => {
        const url = r.url();
        if (!url.startsWith(`${ORIGIN}/`) && !url.startsWith("data:")) problems.push(`foreign request: ${url}`);
      });
      await use();
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
