import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, SecretRegistry } from "../../src/logging/logger.ts";

function capture(env: NodeJS.ProcessEnv = {}) {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (c) => chunks.push(String(c)));
  const secrets = new SecretRegistry(env);
  const { log } = createLogger({ console: false, stream, secrets, level: "debug" });
  return { log, secrets, text: () => chunks.join("") };
}

describe("logger redaction", () => {
  it("redacts secret-looking keys at any depth", () => {
    const { log, text } = capture();
    log.info({ password: "hunter22", nested: { apiKey: "abc123", token: "t0k3n" }, ok: "visible" }, "msg");
    expect(text()).not.toMatch(/hunter22|abc123|t0k3n/);
    expect(text()).toContain("visible");
    expect(text()).toContain("[REDACTED]");
  });

  it("scrubs WELLS_* values wherever they appear, including the message", () => {
    const { log, text } = capture({ WELLS_TX_PASSWORD: "pa55word!" });
    log.warn({ detail: "login with pa55word! failed" }, "typed pa55word! into the form");
    log.error(new Error("server echoed pa55word!"));
    expect(text()).not.toContain("pa55word!");
  });

  it("scrubs values registered at runtime", () => {
    const { log, secrets, text } = capture();
    secrets.add("late-secret");
    log.info({ url: "https://x/?q=late-secret" }, "late-secret");
    expect(text()).not.toContain("late-secret");
  });

  it("keeps credential key names in credentialsUsed", () => {
    const { log, text } = capture();
    log.info({ credentialsUsed: ["WELLS_TX_USERNAME (env)"] }, "credentials.resolved");
    expect(text()).toContain("WELLS_TX_USERNAME (env)");
  });
});
