import { expect, test } from "./fixtures.ts";

test("epics page: every epic from the menu, also one not in progress, each linking to its page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Epics" }).click();
  await expect(page).toHaveURL(/\/epics$/);
  await expect(page.getByTestId("epics-row")).toHaveCount(2);
  await expect(page.locator('[data-testid="epics-row"][data-id="FX-100"]')).toContainText("$1.50");
  await page.locator('[data-testid="epics-row"][data-id="FX-300"]').getByRole("link", { name: "FX-300" }).click();
  await expect(page).toHaveURL(/\/epics\/FX-300$/);
});

test("epic page: costs, how each ticket went, a filter by ticket, and no session text", async ({ page }) => {
  await page.goto("/epics/FX-100");
  await expect(page.getByRole("heading", { name: "FX-100" })).toBeVisible();
  await expect(page.getByTestId("cost-orchestrator")).toContainText("$1.50");
  await expect(page.getByTestId("cost-tickets")).not.toContainText("n/a");

  const rows = page.getByTestId("epic-row");
  await expect(page.locator('[data-testid="epic-row"][data-ticket="FX-104"]').filter({ hasText: "Waiting for approval" })).toBeVisible();
  await expect(page.locator('[data-testid="epic-row"][data-ticket="FX-101"]').last()).toContainText("Shipped");
  await expect(page.getByText("waits for your approval")).toHaveCount(0);

  await page.getByTestId("trace-filter").filter({ hasText: "FX-104" }).click();
  await expect(page.locator('[data-testid="epic-row"]:not([data-ticket="FX-104"])')).toHaveCount(0);
  await expect(rows.first()).toBeVisible();

  await expect(page.locator('[data-testid="epic-ticket"][data-id="FX-102"]').getByRole("link", { name: "FX-102" })).toBeVisible();
});

test("epic page with no runs says so, and an unknown orchestrator cost is n/a", async ({ page }) => {
  await page.goto("/epics/FX-300");
  await expect(page.getByText("No ticket of this epic has a run yet.")).toBeVisible();
  await expect(page.getByTestId("cost-orchestrator")).toContainText("n/a");
});

test("tickets page links to the epic page when an epic is picked", async ({ page }) => {
  await page.goto("/tickets?epic=FX-100");
  await page.getByTestId("epic-page-link").click();
  await expect(page).toHaveURL(/\/epics\/FX-100$/);
});
