import type { TicketsResponse } from "../../plugins/warden/src/site/api-types.ts";
import { expect, test } from "./fixtures.ts";

const body: TicketsResponse = {
  state: "no-tool", generatedAt: new Date().toISOString(), message: "No ticket tool is set for this project.",
  help: {
    rolesFile: ".warden/tools/roles.json", example: '{ "tickets": "<tool name>" }',
    steps: [
      'Add a tool that prints your tickets as JSON (see the "Write a ticket tool" guide).',
      "List it in .warden/tools/index.ts.",
      'Name it in .warden/tools/roles.json under "tickets".',
      "Commit .warden/ to the main branch.",
    ],
    commands: ["warden tools --init", "warden tools --check"],
  },
};

test("no ticket tool: the page says how to add one", async ({ page }) => {
  await page.route("**/api/tickets", (route) => route.fulfill({ json: body }));
  await page.goto("/tickets");
  const steps = page.getByTestId("ticket-tool-steps").getByRole("listitem");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(2)).toContainText("roles.json");
  await expect(page.getByTestId("command-block").first()).toContainText("warden tools --init");

  await page.goto("/");
  await expect(page.getByText("Add a ticket tool to see epics")).toBeVisible();
});
