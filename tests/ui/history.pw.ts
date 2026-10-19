import { expect, test } from "./fixtures.ts";

const tasks = (page: import("@playwright/test").Page) =>
  page.getByTestId("history-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-task")));

test("shipped by default, flow filter, totals and done runs", async ({ page }) => {
  await page.goto("/history");
  await expect(page.getByTestId("history-row").first()).toBeVisible();
  expect(await tasks(page)).toEqual(["FX-101", "FX-095", "FX-094", "FX-093", "FX-092", "FX-091", "FX-090"]);
  await expect(page.getByTestId("total-runs")).toHaveText("7");

  await page.getByTestId("flow-filter").click();
  await page.getByRole("option", { name: "chore" }).click();
  await expect(page).toHaveURL(/flow=chore/);
  await expect(page.getByTestId("total-runs")).toHaveText("6");
  await expect(page.getByTestId("history-row")).toHaveCount(6);
  expect(await tasks(page)).toEqual(["FX-095", "FX-094", "FX-093", "FX-092", "FX-091", "FX-090"]);

  await page.goto("/history");
  await page.getByRole("switch", { name: "Include done runs" }).click();
  await expect(page).toHaveURL(/done=1/);
  await expect(page.locator('[data-testid="history-row"][data-task="FX-150"]')).toBeVisible();
  await expect(page.getByTestId("total-runs")).toHaveText("8");
});
