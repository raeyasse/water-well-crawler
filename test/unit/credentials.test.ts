import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialsMissingError } from "../../src/core/errors.ts";
import { describeCredentials, resolveCredentials, userConfigDir } from "../../src/credentials/resolve.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "wells-cred-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, ".config", "well-scraper"), { recursive: true });
  return { cwd, home, userFile: join(home, ".config", "well-scraper", "credentials.env") };
}

describe("resolveCredentials", () => {
  it("prefers env, then .env, then user file — per key", () => {
    const { cwd, home, userFile } = setup();
    writeFileSync(join(cwd, ".env"), "WELLS_TX_USERNAME=from-dotenv\nWELLS_TX_PASSWORD=dotenv-pass\n");
    writeFileSync(userFile, "WELLS_TX_USERNAME=from-user\nWELLS_TX_PASSWORD=user-pass\nWELLS_TX_TOKEN=user-token\n");
    const env = { WELLS_TX_USERNAME: "from-env" };

    const set = resolveCredentials("TX", ["USERNAME", "PASSWORD", "TOKEN"], { env, cwd, home, platform: "linux" });
    expect(set.values).toEqual({ USERNAME: "from-env", PASSWORD: "dotenv-pass", TOKEN: "user-token" });
    expect(describeCredentials(set)).toEqual([
      "WELLS_TX_USERNAME (environment variable)",
      "WELLS_TX_PASSWORD (.env file)",
      "WELLS_TX_TOKEN (user credentials file)",
    ]);
  });

  it("does not mutate process env when reading .env", () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, ".env"), "WELLS_ZZ_USERNAME=x\n");
    const env: NodeJS.ProcessEnv = {};
    resolveCredentials("ZZ", ["USERNAME"], { env, cwd, home, platform: "linux" });
    expect(env).toEqual({});
  });

  it("lists missing key names and places checked, never values", () => {
    const { cwd, home } = setup();
    const env = { WELLS_TX_USERNAME: "super-secret-user" };
    try {
      resolveCredentials("TX", ["USERNAME", "PASSWORD"], { env, cwd, home, platform: "linux" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialsMissingError);
      const e = err as CredentialsMissingError;
      expect(e.exitCode).toBe(4);
      expect(e.missingKeys).toEqual(["WELLS_TX_PASSWORD"]);
      expect(e.message).toContain(".env");
      expect(e.message).toContain("credentials.env");
      expect(e.message).not.toContain("super-secret-user");
    }
  });

  it("uses %APPDATA% on Windows", () => {
    expect(userConfigDir({ env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, platform: "win32", home: "C:\\Users\\a" })).toMatch(/well-scraper$/);
  });
});
