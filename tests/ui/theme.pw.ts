import { expect, test } from "./fixtures.ts";

test("the toggle sets data-theme and survives a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
});

test.describe("dark system theme", () => {
  test.use({ colorScheme: "dark" });
  test("starts dark with no stored pick", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});
