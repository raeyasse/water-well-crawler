import type { Page } from "playwright";

/** All demo-site locators. Role/label/text locators survive front-end rebuilds better than CSS classes. */
export const sel = {
  agree: (p: Page) => p.getByRole("button", { name: "I Agree" }),
  countySelect: (p: Page) => p.getByLabel("County"),
  search: (p: Page) => p.getByRole("button", { name: "Search" }),
  resultsTable: (p: Page) => p.getByRole("table", { name: /wells found/i }),
  resultRows: (p: Page) => p.getByRole("table", { name: /wells found/i }).locator("tbody tr"),
  empty: (p: Page) => p.getByText("No wells found"),
  next: (p: Page) => p.getByRole("button", { name: "Next" }),
  retry: (p: Page) => p.getByRole("button", { name: "Retry" }),
  pageStatus: (p: Page) => p.getByText(/^Page \d+ of \d+$/),

  username: (p: Page) => p.getByLabel("Username"),
  password: (p: Page) => p.getByLabel("Password"),
  signIn: (p: Page) => p.getByRole("button", { name: "Sign in" }),
  signOut: (p: Page) => p.getByRole("button", { name: "Sign out" }),
  loginError: (p: Page) => p.getByRole("alert"),
};
