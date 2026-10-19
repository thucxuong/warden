import { expect, test } from "./fixtures.ts";

const column = (id: string) => `[data-testid="board-column"][data-column="${id}"]`;

test("board: five columns with counts and cards in the right place", async ({ page }) => {
  await page.goto("/tickets");
  await expect(page.getByTestId("board-column")).toHaveCount(5);
  const counts = await page.getByTestId("board-column").evaluateAll((els) =>
    els.map((e) => [e.getAttribute("data-column"), e.querySelector('[data-testid="column-count"]')?.textContent]));
  expect(counts).toEqual([["backlog", "1"], ["todo", "4"], ["in-progress", "10"], ["done", "1"], ["archived", "1"]]);
  await expect(page.locator(`${column("in-progress")} [data-testid="ticket-card"][data-id="FX-104"]`)).toContainText("review");
  await expect(page.locator(`${column("backlog")} [data-testid="ticket-card"][data-id="FX-105"]`)).toBeVisible();
  await expect(page.locator(`${column("archived")} [data-testid="ticket-card"][data-id="FX-106"]`)).toBeVisible();
});

test("board: dragging a card does not move it", async ({ page }) => {
  await page.goto("/tickets");
  const card = page.locator('[data-testid="ticket-card"][data-id="FX-105"]');
  await expect(card).toBeVisible();
  const from = (await card.boundingBox())!;
  const to = (await page.locator(column("done")).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(`${column("backlog")} [data-testid="ticket-card"][data-id="FX-105"]`)).toBeVisible();
  await expect(page.locator(`${column("backlog")} [data-testid="column-count"]`)).toHaveText("1");
  await expect(page.locator(`${column("done")} [data-testid="column-count"]`)).toHaveText("1");
});

test("DAG: nodes, the FX-102 -> FX-103 edge, epic filter and signals", async ({ page }) => {
  await page.goto("/tickets");
  await page.getByRole("radio", { name: "DAG" }).click();
  await expect(page).toHaveURL(/view=dag/);
  await expect(page.getByTestId("dag-node")).toHaveCount(17);
  await expect(page.locator('.react-flow__edge[data-id="FX-102->FX-103"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="dag-node"][data-id="FX-203"] [data-testid="signal-badge"]')).toHaveAttribute("aria-label", /^Job gone/);

  await page.getByTestId("epic-filter").click();
  await page.getByRole("option", { name: /FX-300/ }).click();
  await expect(page).toHaveURL(/epic=FX-300/);
  await expect(page.getByTestId("dag-node")).toHaveCount(2);
});

test("DAG: a filter with no tickets shows a message, not an empty canvas", async ({ page }) => {
  // Every fixture epic has tickets, so drop the tickets without an epic: then "No epic" matches nothing.
  await page.route("**/api/tickets", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.tickets = body.tickets.filter((t: { epic: string | null }) => t.epic !== null);
    await route.fulfill({ response: res, json: body });
  });
  await page.goto("/tickets?view=dag&epic=none");
  await expect(page.getByText("No tickets match this filter.")).toBeVisible();
  await expect(page.getByTestId("dag")).toHaveCount(0);
  await page.unroute("**/api/tickets");
  await page.goto("/tickets?view=dag&epic=NOPE-1");   // an unknown epic shows all
  await expect(page.getByTestId("dag-node")).toHaveCount(17);
});
