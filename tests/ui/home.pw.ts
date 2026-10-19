import { expect, test } from "./fixtures.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("needs you: blocked and waiting runs with the exact commands", async ({ page }) => {
  const items = page.getByTestId("needs-you-item");
  await expect(items).toHaveCount(4);
  const item = (task: string) => page.locator(`[data-testid="needs-you-item"][data-task="${task}"]`);
  await expect(item("FX-104").getByTestId("command-block").first()).toContainText("warden approve FX-104");
  await expect(item("FX-104").getByTestId("command-block").nth(1)).toContainText("reject FX-104");
  await expect(item("FX-201").getByTestId("command-block")).toContainText("warden retry FX-201");
  await expect(item("FX-204")).toContainText("Should totals include weekends?");
  await expect(item("FX-204").getByTestId("command-block")).toContainText("warden retry FX-204");
  await expect(item("FX-208")).toContainText("warden-fix/FX-208-1");
});

test("running: live runs with their warning badges", async ({ page }) => {
  const rows = page.getByTestId("running-row");
  await expect(rows).toHaveCount(6);
  for (const t of ["FX-102", "FX-202", "FX-203", "FX-205", "FX-206", "FX-207"]) await expect(page.locator(`[data-testid="running-row"][data-task="${t}"]`)).toBeVisible();
  const badge = (task: string) => page.locator(`[data-testid="running-row"][data-task="${task}"] [data-testid="signal-badge"]`);
  await expect(badge("FX-202")).toHaveAttribute("data-kind", "loop");
  await expect(badge("FX-202")).toHaveText("Loop");
  await expect(badge("FX-203")).toHaveText("Job gone");
  await expect(badge("FX-205")).toHaveText("Slow");
  await expect(badge("FX-207")).toHaveText("Slow");
  await expect(badge("FX-102")).toHaveCount(0);
  await expect(badge("FX-206")).toHaveCount(0);
});

test("epics: FX-100 in progress, FX-300 not shown", async ({ page }) => {
  const cards = page.getByTestId("epic-card");
  await expect(cards).toHaveCount(1);
  await expect(page.locator('[data-testid="epic-card"][data-id="FX-100"]')).toContainText("1 / 6");
  await expect(page.locator('[data-testid="epic-card"][data-id="FX-300"]')).toHaveCount(0);
});

test("recently shipped: PR link and merge label", async ({ page }) => {
  const row = (task: string) => page.locator(`[data-testid="shipped-row"][data-task="${task}"]`);
  await expect(row("FX-101").getByRole("link", { name: /#7/ })).toHaveAttribute("href", "https://github.com/acme/fx/pull/7");
  await expect(row("FX-090")).toContainText("#5");
});

test("reports and project health", async ({ page }) => {
  const reports = page.getByTestId("report-item");
  await expect(reports.filter({ hasText: "Which version?" })).toHaveCount(1);
  await expect(reports.filter({ hasText: "Which version?" }).getByTestId("command-block")).toContainText("warden report reply R-ab12-0001");
  await expect(page.locator('[data-testid="report-item"] [data-testid="signal-badge"]', { hasText: "Job gone" })).toHaveCount(1);

  await expect(page.getByTestId("upgrade-notice")).toBeVisible();
  await expect(page.getByTestId("health-tools-row").filter({ hasText: "api key" })).toContainText("FAIL");
  await expect(page.locator('[data-testid="config-problem"][data-severity="error"]', { hasText: "flows/broken.json" })).toBeVisible();
  await expect(page.locator('[data-testid="config-problem"][data-severity="warn"]', { hasText: "slowFactor" })).toBeVisible();
});

test("the page never shows the answer runner's secrets", async ({ page }) => {
  await expect(page.getByTestId("report-item").first()).toBeVisible();
  expect(await page.content()).not.toContain("SECRET_TOKEN");
});

test("signal badges: the threshold sits next to the badge, and the keyboard opens the detail", async ({ page }) => {
  const row = page.locator('[data-testid="running-row"][data-task="FX-205"]');
  await expect(row.getByTestId("signal-threshold")).toContainText("flagged above");
  const badge = row.getByTestId("signal-badge");
  await badge.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("usual");
});
