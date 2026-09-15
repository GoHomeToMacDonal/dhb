import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  credentialsPath,
  CredentialsError,
  loadCredentials,
  loadDeepSeekApiKey,
  validateCredentials,
} from "../src/credentials.ts";

describe("credentialsPath", () => {
  it("uses $DSH_HOME when set", () => {
    expect(credentialsPath({ DSH_HOME: "/opt/dsh" })).toBe("/opt/dsh/.credentials.yaml");
  });

  it("falls back to ~/.dsh when DSH_HOME is unset or blank", () => {
    const home = process.env.HOME ?? "";
    expect(credentialsPath({})).toBe(join(home, ".dsh", ".credentials.yaml"));
    expect(credentialsPath({ DSH_HOME: "   " })).toBe(join(home, ".dsh", ".credentials.yaml"));
  });
});

describe("validateCredentials", () => {
  const valid = { version: 1, refs: { DEEPSEEK_API_KEY: "sk-abc" } };

  it("accepts a minimal valid document", () => {
    expect(validateCredentials(valid)).toEqual(valid);
  });

  it("preserves records verbatim", () => {
    const doc = { version: 1, refs: { DEEPSEEK_API_KEY: "k" }, records: [{ a: 1 }, "x"] };
    expect(validateCredentials(doc).records).toEqual([{ a: 1 }, "x"]);
  });

  it("rejects a non-mapping top level", () => {
    expect(() => validateCredentials(["x"])).toThrow(CredentialsError);
    expect(() => validateCredentials("x")).toThrow(/must be a mapping/);
    expect(() => validateCredentials(null)).toThrow(/must be a mapping/);
  });

  it("rejects unexpected top-level keys", () => {
    expect(() => validateCredentials({ ...valid, extra: 1 })).toThrow(/unexpected key "extra"/);
  });

  it("requires version 1", () => {
    expect(() => validateCredentials({ ...valid, version: 2 })).toThrow(/version must be 1/);
    expect(() => validateCredentials({ refs: valid.refs })).toThrow(/version must be 1/);
  });

  it("requires refs to be a string mapping", () => {
    expect(() => validateCredentials({ version: 1, refs: "x" })).toThrow(/must be a mapping/);
    expect(() => validateCredentials({ version: 1, refs: { X: 5 } })).toThrow(
      /"refs.X" must be a string/,
    );
  });

  it("requires a non-empty DEEPSEEK_API_KEY", () => {
    expect(() => validateCredentials({ version: 1, refs: {} })).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => validateCredentials({ version: 1, refs: { DEEPSEEK_API_KEY: "" } })).toThrow(
      /non-empty DEEPSEEK_API_KEY/,
    );
  });
});

describe("loadCredentials", () => {
  let dir: string;
  let file: string;
  const env = () => ({ DSH_HOME: dir });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dhb-creds-"));
    file = join(dir, ".credentials.yaml");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeCreds(content: string, mode = 0o600): Promise<void> {
    await writeFile(file, content, "utf8");
    await chmod(file, mode);
  }

  it("loads a valid owner-only file", async () => {
    await writeCreds("version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-live\n");
    const creds = await loadCredentials(env());
    expect(creds.refs.DEEPSEEK_API_KEY).toBe("sk-live");
  });

  it("throws when the file is missing", async () => {
    await expect(loadCredentials(env())).rejects.toThrow(/not found/);
  });

  it("rejects group- or world-accessible permissions", async () => {
    await writeCreds("version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-live\n", 0o644);
    await expect(loadCredentials(env())).rejects.toThrow(/owner-only/);
  });

  it("rejects a symlinked credentials file", async () => {
    const real = join(dir, "real.yaml");
    await writeFile(real, "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-live\n", "utf8");
    await chmod(real, 0o600);
    await symlink(real, file);
    await expect(loadCredentials(env())).rejects.toThrow(/must not be a symlink/);
  });

  it("rejects invalid YAML", async () => {
    await writeCreds("version: 1\n refs: : :\n  bad\n");
    await expect(loadCredentials(env())).rejects.toThrow(/valid YAML|mapping|DEEPSEEK/);
  });

  it("loadDeepSeekApiKey returns the key from the file only", async () => {
    await writeCreds("version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-from-file\n");
    const key = await loadDeepSeekApiKey({ DSH_HOME: dir, DEEPSEEK_API_KEY: "sk-from-env" });
    expect(key).toBe("sk-from-file");
  });
});
