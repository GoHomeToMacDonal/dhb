import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubCacheDir, hubEndpoint, resolveHubFile } from "../src/tokens/backends/hub-cache.ts";

const CONTENT = '{"hello":"world"}';
const SHA256 = createHash("sha256").update(CONTENT).digest("hex");
const REVISION = "0123456789abcdef0123456789abcdef01234567";

let workDir: string;
let server: Server;
let requests: { url: string; range: string | undefined }[];
const savedEnv: Record<string, string | undefined> = {};

/**
 * A minimal mirror: answers only `GET /{repo}/resolve/{rev}/{path}` with a
 * plain 200 (no Content-Range, no xet headers, no `/api` routes) after a
 * redirect, which is how many mirrors and proxies behave.
 */
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "dhb-hub-"));
  for (const key of ["HF_HUB_CACHE", "HF_HOME", "HF_ENDPOINT", "XDG_CACHE_HOME"]) {
    savedEnv[key] = process.env[key];
  }
  requests = [];
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", range: req.headers.range });
    if (req.url === `/org/repo/resolve/${REVISION}/tokenizer.json`) {
      res.writeHead(302, { location: "/cdn/blob" }).end();
    } else if (req.url === "/cdn/blob") {
      res.writeHead(200, { "content-type": "application/json" }).end(CONTENT);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.HF_HUB_CACHE = join(workDir, "hub");
  process.env.HF_ENDPOINT = `http://127.0.0.1:${port}/`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(workDir, { recursive: true, force: true });
});

const request = (sha256 = SHA256) => ({
  repo: "org/repo",
  revision: REVISION,
  file: { path: "tokenizer.json", etag: "abc123", sha256 },
});

describe("resolveHubFile", () => {
  it("downloads from a mirror that ignores Range and lays out the HF cache", async () => {
    const notices: string[] = [];
    const path = await resolveHubFile(request(), (url) => notices.push(url));

    const repoDir = join(workDir, "hub", "models--org--repo");
    expect(path).toBe(join(repoDir, "snapshots", REVISION, "tokenizer.json"));
    expect(await readFile(path, "utf8")).toBe(CONTENT);
    expect(await readlink(path)).toBe(join("..", "..", "blobs", "abc123"));
    expect((await stat(join(repoDir, "blobs", "abc123"))).isFile()).toBe(true);
    expect(notices).toEqual([
      `${process.env.HF_ENDPOINT?.replace(/\/$/, "")}/org/repo/resolve/${REVISION}/tokenizer.json`,
    ]);
    expect(requests.every((r) => r.range === undefined)).toBe(true);
  });

  it("serves a cached snapshot without any request", async () => {
    await resolveHubFile(request());
    const count = requests.length;
    await resolveHubFile(request());
    expect(requests.length).toBe(count);
  });

  it("rejects content that does not match the pinned checksum and caches nothing", async () => {
    await expect(resolveHubFile(request("0".repeat(64)))).rejects.toThrow(/checksum mismatch/);
    await expect(
      stat(join(workDir, "hub", "models--org--repo", "blobs", "abc123")),
    ).rejects.toThrow();
  });

  it("reports HTTP errors with the URL", async () => {
    const missing = { ...request(), file: { ...request().file, path: "missing.json" } };
    await expect(resolveHubFile(missing)).rejects.toThrow(/missing\.json: HTTP 404/);
  });
});

describe("hub settings", () => {
  it("resolves the cache dir like huggingface_hub", () => {
    expect(hubCacheDir({ HF_HUB_CACHE: "/a" })).toBe("/a");
    expect(hubCacheDir({ HF_HOME: "/h" })).toBe(join("/h", "hub"));
    expect(hubCacheDir({ XDG_CACHE_HOME: "/x" })).toBe(join("/x", "huggingface", "hub"));
  });

  it("validates HF_ENDPOINT", () => {
    expect(hubEndpoint({})).toBe("https://huggingface.co");
    expect(hubEndpoint({ HF_ENDPOINT: "https://hf-mirror.com/" })).toBe("https://hf-mirror.com");
    expect(() => hubEndpoint({ HF_ENDPOINT: "ftp://x" })).toThrow(/http\(s\)/);
    expect(() => hubEndpoint({ HF_ENDPOINT: "not a url" })).toThrow(/valid URL/);
  });
});
