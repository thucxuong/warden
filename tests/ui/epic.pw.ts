import { expect, test } from "./fixtures.ts";

test("epic page: costs, what the orchestrator did, and the tickets", async ({ page }) => {
  await page.goto("/epics/FX-100");
  await expect(page.getByRole("heading", { name: "FX-100" })).toBeVisible();
  await expect(page.getByText("Billing")).toBeVisible();
  await expect(page.getByTestId("cost-orchestrator")).toContainText("$1.50");
  await expect(page.getByTestId("cost-tickets")).not.toContainText("n/a");

  const rows = page.getByTestId("epic-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Planned the epic");
  await expect(rows.nth(1)).toContainText("Started FX-102, FX-104");
  await expect(rows.nth(2)).toContainText("Ticket agents working on FX-102, FX-104");
  await expect(rows.nth(3)).toHaveAttribute("data-kind", "stop");
  await rows.nth(3).getByText("FX-104 waits for your approval").first().click();
  await expect(rows.nth(3).locator("details")).toHaveAttribute("open", "");

  await expect(page.locator('[data-testid="epic-ticket"][data-id="FX-102"]').getByRole("link", { name: "FX-102" })).toBeVisible();
});

test("epic page without an orchestrator session says where the steps come from", async ({ page }) => {
  await page.goto("/epics/FX-300");
  await expect(page.getByText("No orchestrator session found for this epic.")).toBeVisible();
  await expect(page.getByText(".warden/history/FX-300/epic.json")).toBeVisible();
});

test("tickets page links to the epic page when an epic is picked", async ({ page }) => {
  await page.goto("/tickets?epic=FX-100");
  await page.getByTestId("epic-page-link").click();
  await expect(page).toHaveURL(/\/epics\/FX-100$/);
});
