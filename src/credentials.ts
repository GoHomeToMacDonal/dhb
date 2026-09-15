import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Parsed, validated credentials file.
 *
 * `refs` holds string-valued references (API keys and similar secrets).
 * `records` is optional free-form data that is preserved verbatim and never
 * structurally validated, so callers can stash bookkeeping without this module
 * needing to understand it.
 */
export interface Credentials {
  version: 1;
  refs: Record<string, string>;
  records?: unknown;
}

/** Raised for any failure to locate, read, or validate the credentials file. */
export class CredentialsError extends Error {
  override name = "CredentialsError";
}

/** The single required reference: the DeepSeek API key. */
export const DEEPSEEK_API_KEY = "DEEPSEEK_API_KEY";

/**
 * Resolve the credentials file path.
 *
 * `$DSH_HOME/.credentials.yaml` when `DSH_HOME` is set and non-empty,
 * otherwise `~/.dsh/.credentials.yaml`.
 */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = env.DSH_HOME?.trim();
  const base = dshHome ? dshHome : join(homedir(), ".dsh");
  return join(base, ".credentials.yaml");
}

/**
 * Load and validate the credentials file.
 *
 * Security checks, in order:
 * 1. `lstat` the path (not `stat`) so a symlink is detected rather than
 *    followed; symlinks are rejected outright.
 * 2. The target must be a regular file.
 * 3. Permissions must be owner-only — no group or other bits may be set
 *    (typically `0600`).
 *
 * The file is then parsed as YAML and structurally validated.
 */
export async function loadCredentials(env: NodeJS.ProcessEnv = process.env): Promise<Credentials> {
  const path = credentialsPath(env);

  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CredentialsError(`credentials file not found at ${path}`);
    }
    throw new CredentialsError(`unable to access credentials file at ${path}`);
  }

  if (stats.isSymbolicLink()) {
    throw new CredentialsError(`credentials file must not be a symlink: ${path}`);
  }
  if (!stats.isFile()) {
    throw new CredentialsError(`credentials file must be a regular file: ${path}`);
  }
  if ((stats.mode & 0o077) !== 0) {
    const octal = (stats.mode & 0o777).toString(8).padStart(3, "0");
    throw new CredentialsError(
      `credentials file permissions must be owner-only (found 0${octal}): ${path}`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new CredentialsError(`unable to read credentials file at ${path}`);
  }

  return validateCredentials(parseCredentialsYaml(raw, path), path);
}

function parseCredentialsYaml(raw: string, path: string): unknown {
  try {
    return parseYaml(raw);
  } catch {
    throw new CredentialsError(`credentials file is not valid YAML: ${path}`);
  }
}

/**
 * Validate the parsed document against the credentials schema:
 * - top level is a plain mapping whose only allowed keys are `version`,
 *   `refs`, and `records`;
 * - `version` is the number `1`;
 * - `refs` is a mapping of strings to strings;
 * - a non-empty {@link DEEPSEEK_API_KEY} exists in `refs`;
 * - `records`, if present, is preserved as-is.
 */
export function validateCredentials(doc: unknown, path = "<memory>"): Credentials {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new CredentialsError(`credentials file must be a mapping: ${path}`);
  }

  const record = doc as Record<string, unknown>;
  const allowed = new Set(["version", "refs", "records"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new CredentialsError(`credentials file has unexpected key "${key}": ${path}`);
    }
  }

  if (record.version !== 1) {
    throw new CredentialsError(`credentials file version must be 1: ${path}`);
  }

  const refs = record.refs;
  if (typeof refs !== "object" || refs === null || Array.isArray(refs)) {
    throw new CredentialsError(`credentials "refs" must be a mapping: ${path}`);
  }

  const refsRecord = refs as Record<string, unknown>;
  const validatedRefs: Record<string, string> = {};
  for (const [key, value] of Object.entries(refsRecord)) {
    if (typeof value !== "string") {
      throw new CredentialsError(`credentials "refs.${key}" must be a string: ${path}`);
    }
    validatedRefs[key] = value;
  }

  const apiKey = validatedRefs[DEEPSEEK_API_KEY];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new CredentialsError(
      `credentials must define a non-empty ${DEEPSEEK_API_KEY} in "refs": ${path}`,
    );
  }

  const credentials: Credentials = { version: 1, refs: validatedRefs };
  if ("records" in record) {
    credentials.records = record.records;
  }
  return credentials;
}

/**
 * Default API key loader used by the commit agent. Reads the DeepSeek API key
 * only from the credentials file — there is deliberately no environment
 * variable fallback, so a key can never leak in from process env.
 */
export async function loadDeepSeekApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const credentials = await loadCredentials(env);
  const key = credentials.refs[DEEPSEEK_API_KEY];
  if (key === undefined || key.length === 0) {
    throw new CredentialsError(`credentials are missing ${DEEPSEEK_API_KEY}`);
  }
  return key;
}
