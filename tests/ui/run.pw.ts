import { expect, test } from "./fixtures.ts";

test("FX-202: timeline with three loop arrows", async ({ page }) => {
  await page.goto("/runs/FX-202");
  await expect(page.getByTestId("timeline-step")).toHaveCount(9);
  const keys = await page.getByTestId("timeline-step").evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
  expect(keys).toEqual(["plan#1", "implement#1", "check#1", "implement#2", "check#2", "implement#3", "check#3", "review#1", "implement#4"]);
  await expect(page.getByTestId("timeline-loop")).toHaveCount(3);
});

test("FX-202: gates show the failed command's log tail and the CODE triage", async ({ page }) => {
  await page.goto("/runs/FX-202?tab=gates");
  const gate = page.locator('[data-testid="gate-run"][data-key="check#1/1"]');
  await expect(gate.getByTestId("log-tail")).toBeVisible();
  await expect(gate.getByTestId("triage")).toContainText("CODE");
});

test("FX-202: review shows the two open blocking findings", async ({ page }) => {
  await page.goto("/runs/FX-202?tab=review");
  const open = page.locator('[data-testid="unresolved"] [data-testid="finding"][data-state="open"][data-severity="blocking"]');
  await expect(open).toHaveCount(2);
});

test("FX-201: the log tail is visible and Show more loads /log", async ({ page }) => {
  await page.goto("/runs/FX-201?tab=gates");
  await expect(page.getByTestId("log-tail").first()).toBeVisible();
  const log = page.waitForResponse((r) => r.url().includes("/api/runs/FX-201/log?") && r.status() === 200);
  await page.getByRole("button", { name: "Show more" }).first().click();
  await log;
  await expect(page.getByTestId("log-shown")).toBeVisible();
});

test("FX-101: PR, plan waves, files, commits and token totals", async ({ page }) => {
  await page.goto("/runs/FX-101?tab=plan");
  await expect(page.getByRole("link", { name: /#7/ }).first()).toHaveAttribute("href", "https://github.com/acme/fx/pull/7");
  await expect(page.getByTestId("plan-waves")).toContainText("Wave 2");
  await expect(page.getByTestId("changed-files")).toContainText("src/fx-101.ts");
  await expect(page.getByTestId("commits")).toContainText("feat(FX-101): Invoice totals");
  await page.getByRole("tab", { name: "Tokens" }).click();
  await expect(page).toHaveURL(/tab=tokens/);
  await expect(page.getByTestId("tokens-total")).toContainText("Total");
});

test("FX-090: a history run says where its data comes from", async ({ page }) => {
  await page.goto("/runs/FX-090");
  await expect(page.getByTestId("limitations")).toContainText("From the committed history");
});

test.describe("unknown run", () => {
  test.use({ allowConsole: [/status of 404/] });
  test("FX-999: not-found state", async ({ page }) => {
    await page.goto("/runs/FX-999");
    await expect(page.getByText("no run FX-999 on this machine or in .warden/history")).toBeVisible();
  });
});
