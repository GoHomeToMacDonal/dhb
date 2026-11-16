import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

/** A pinned file in a Hub repository. */
export interface HubFile {
  /** Path inside the repository, e.g. `tokenizer.json`. */
  path: string;
  /**
   * Blob id the Hub reports as the file's ETag: the git blob SHA-1 for regular
   * files, the SHA-256 for LFS files. Used as the blob name in the cache, the
   * same way Python `huggingface_hub` names it.
   */
  etag: string;
  /** SHA-256 of the file content, verified after every download. */
  sha256: string;
}

export interface HubFileRequest {
  repo: string;
  revision: string;
  file: HubFile;
}

/** Downloads larger than this are aborted. Tokenizer files are a few MB. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_ENDPOINT = "https://huggingface.co";

/**
 * Standard Hugging Face hub cache directory, resolved the same way as Python
 * `huggingface_hub`: `$HF_HUB_CACHE`, else `$HF_HOME/hub`, else
 * `$XDG_CACHE_HOME/huggingface/hub`, else `~/.cache/huggingface/hub`.
 */
export function hubCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const hubCache = env.HF_HUB_CACHE?.trim();
  if (hubCache) return hubCache;
  const hfHome =
    env.HF_HOME?.trim() ||
    join(env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "huggingface");
  return join(hfHome, "hub");
}

/** Hub endpoint: `$HF_ENDPOINT` (e.g. a mirror) or huggingface.co. */
export function hubEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HF_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`HF_ENDPOINT is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`HF_ENDPOINT must be an http(s) URL: ${raw}`);
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * Return the local path of a pinned Hub file, downloading it into the hub
 * cache on first use. A cached snapshot is returned without any network
 * request.
 *
 * Downloads are a single plain `GET {endpoint}/{repo}/resolve/{revision}/{path}`
 * (redirects followed), which every Hub mirror supports. The content is
 * checked against the pinned SHA-256 before it enters the cache.
 */
export async function resolveHubFile(
  request: HubFileRequest,
  onDownload?: (url: string) => void,
): Promise<string> {
  const { repo, revision, file } = request;
  const repoDir = join(hubCacheDir(), `models--${repo.replaceAll("/", "--")}`);
  const pointer = join(repoDir, "snapshots", revision, ...file.path.split("/"));
  if (await exists(pointer)) {
    return pointer;
  }

  const blob = join(repoDir, "blobs", file.etag);
  if (!(await exists(blob))) {
    const url = `${hubEndpoint()}/${repo}/resolve/${revision}/${file.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    onDownload?.(url);
    const content = await download(url);
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== file.sha256) {
      throw new Error(
        `checksum mismatch for ${repo}/${file.path} from ${url} (expected sha256 ${file.sha256}, got ${actual})`,
      );
    }
    await mkdir(dirname(blob), { recursive: true });
    // Write to a temp name and rename so an interrupted download never leaves
    // a truncated blob in the cache.
    const incomplete = `${blob}.${process.pid}.incomplete`;
    try {
      await writeFile(incomplete, content);
      await rename(incomplete, blob);
    } finally {
      await rm(incomplete, { force: true });
    }
  }

  await mkdir(dirname(pointer), { recursive: true });
  try {
    await symlink(relative(dirname(pointer), blob), pointer);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return pointer;
    // Symlinks can be unavailable (e.g. Windows without developer mode);
    // Python `huggingface_hub` falls back to copying in the same situation.
    await copyFile(blob, pointer);
  }
  return pointer;
}

async function download(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    const reason = error instanceof Error ? (error.cause ?? error.message) : error;
    throw new Error(`failed to download ${url}: ${String(reason)}`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`refusing to download ${url}: ${declared} bytes exceeds limit`);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_DOWNLOAD_BYTES) {
      throw new Error(`refusing to download ${url}: exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Read a pinned Hub file as a JSON object. */
export async function readHubJsonFile(
  request: HubFileRequest,
  onDownload?: (url: string) => void,
): Promise<Record<string, unknown>> {
  const path = await resolveHubFile(request, onDownload);
  const data: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${request.repo}/${request.file.path} is not a JSON object`);
  }
  return data as Record<string, unknown>;
}
