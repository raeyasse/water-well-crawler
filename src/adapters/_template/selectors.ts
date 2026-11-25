import type { Page } from "playwright";

/** Prefer getByRole/getByLabel/getByText over CSS classes, which change with each SPA build. */
export const sel = {
  countySelect: (p: Page) => p.getByLabel("County"),
  search: (p: Page) => p.getByRole("button", { name: "Search" }),
  resultRows: (p: Page) => p.getByRole("row").filter({ has: p.getByRole("cell") }),
  empty: (p: Page) => p.getByText(/no (results|records|wells)/i),
  next: (p: Page) => p.getByRole("button", { name: /next/i }),
};
