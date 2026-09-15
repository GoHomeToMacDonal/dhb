import { describe, expect, it } from "vitest";
import { REDACTED, StreamRedactor, redactSecrets } from "../src/commit/redaction.ts";

describe("redactSecrets", () => {
  it("masks an explicit known secret by substring", () => {
    const out = redactSecrets("key is sk-live-ABCDEFGH here", ["sk-live-ABCDEFGH"]);
    expect(out).not.toContain("sk-live-ABCDEFGH");
    expect(out).toContain(REDACTED);
  });

  it("does not mask very short extra secrets", () => {
    expect(redactSecrets("value ab", ["ab"])).toContain("ab");
  });

  it("masks Authorization bearer headers", () => {
    const out = redactSecrets("Authorization: Bearer abcdef1234567890TOKEN");
    expect(out).not.toContain("abcdef1234567890TOKEN");
    expect(out.toLowerCase()).toContain("authorization");
  });

  it("masks bearer tokens anywhere", () => {
    const out = redactSecrets("used Bearer abcdef1234567890 to auth");
    expect(out).not.toContain("abcdef1234567890");
    expect(out).toContain(REDACTED);
  });

  it("masks x-api-key and api-key headers", () => {
    expect(redactSecrets("x-api-key: sk-abcdef123456")).not.toContain("sk-abcdef123456");
    expect(redactSecrets('api_key="verysecretvalue"')).not.toContain("verysecretvalue");
  });

  it("masks provider-prefixed keys", () => {
    expect(redactSecrets("token sk-ABCDEFGHIJKL end")).toContain(REDACTED);
    expect(redactSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toContain(REDACTED);
  });

  it("masks secret-named JSON/YAML values", () => {
    expect(redactSecrets('{"password":"hunter2secret"}')).not.toContain("hunter2secret");
    expect(redactSecrets("secret_token: myprivatevalue")).not.toContain("myprivatevalue");
  });

  it("leaves ordinary text untouched", () => {
    const text = "feat(agent): add commit tooling for staged diffs";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("StreamRedactor", () => {
  it("catches a secret split across chunk boundaries", () => {
    const secret = "sk-SPLITSECRET1234";
    const r = new StreamRedactor([secret], 8);
    let emitted = "";
    emitted += r.push("prefix sk-SPLIT");
    emitted += r.push("SECRET1234 suffix");
    emitted += r.flush();
    expect(emitted).not.toContain(secret);
    expect(emitted).toContain("prefix");
    expect(emitted).toContain("suffix");
  });

  it("emits nothing until the buffer exceeds the window", () => {
    const r = new StreamRedactor([], 64);
    expect(r.push("short")).toBe("");
    expect(r.flush()).toBe("short");
  });

  it("reassembles plain streamed text without loss", () => {
    const r = new StreamRedactor([], 4);
    const parts = ["Hello ", "world", ", this ", "is fine."];
    let out = "";
    for (const p of parts) {
      out += r.push(p);
    }
    out += r.flush();
    expect(out).toBe("Hello world, this is fine.");
  });
});
