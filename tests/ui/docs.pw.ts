import { expect, test } from "./fixtures.ts";

test("lists the docs and follows a doc link", async ({ page }) => {
  await page.goto("/docs");
  await expect(page.getByTestId("doc-list")).toContainText("Overview");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await page.locator("a[data-doc]").first().click();
  await expect(page).toHaveURL(/\?path=docs%2Fdecisions%2Fdevops%2F2026-01-05-use-bun\.md|\?path=docs\/decisions\/devops\/2026-01-05-use-bun\.md/);
  await expect(page.getByRole("button", { name: "Use Bun" })).toHaveAttribute("aria-current", "page");
});
