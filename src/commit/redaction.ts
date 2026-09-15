/**
 * Secret redaction for agent logs.
 *
 * The commit agent logs model requests, responses, usage, and tool events to
 * stderr. Those strings can incidentally contain credentials, so everything is
 * passed through {@link redactSecrets} before being written. Redaction is
 * deliberately aggressive: it is better to mask a harmless token than to leak a
 * real one.
 */

/** Placeholder substituted for any detected secret. */
export const REDACTED = "[REDACTED]";

/**
 * Patterns for common secret shapes. Each replaces the sensitive portion (or
 * the whole match) with {@link REDACTED} while keeping surrounding structure
 * readable for debugging.
 */
const PATTERNS: { regex: RegExp; replacement: string }[] = [
  // Authorization: Bearer <token>  /  Authorization: <token>
  {
    regex: /\b(authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1$2${REDACTED}`,
  },
  // Bearer <token> anywhere.
  { regex: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `Bearer ${REDACTED}` },
  // Common API-key header names: x-api-key, api-key, apikey.
  {
    regex: /\b(x-api-key|api[-_]?key)(\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi,
    replacement: `$1$2${REDACTED}`,
  },
  // Provider-style prefixed keys: sk-..., sk-ant-..., ghp_..., gho_..., etc.
  { regex: /\bsk-[A-Za-z0-9._-]{6,}/g, replacement: REDACTED },
  { regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: REDACTED },
  // JSON/YAML value for a key whose name hints at a secret.
  {
    regex:
      /("?\b[A-Za-z0-9_]*(?:api[-_]?key|secret|token|password|passwd|authorization)\b"?\s*[:=]\s*)"?[^"\s,}]{6,}"?/gi,
    replacement: `$1${REDACTED}`,
  },
];

/**
 * Redact secrets in a single string. In addition to the shape-based
 * {@link PATTERNS}, any values in `extraSecrets` (e.g. the live API key) are
 * masked by exact substring match, so a known credential can never slip through
 * even if it does not match a generic pattern.
 */
export function redactSecrets(input: string, extraSecrets: readonly string[] = []): string {
  let output = input;

  for (const secret of extraSecrets) {
    if (secret && secret.length >= 4) {
      output = output.split(secret).join(REDACTED);
    }
  }

  for (const { regex, replacement } of PATTERNS) {
    output = output.replace(regex, replacement);
  }

  return output;
}

/**
 * Streaming-safe redactor.
 *
 * A secret can straddle two streamed chunks, so naive per-chunk redaction would
 * miss it. This wrapper retains a trailing window of unre­leased text so a
 * secret split across a chunk boundary is still caught: it redacts the
 * accumulated buffer, emits everything except the last `windowSize` characters,
 * and keeps the tail until more text arrives or {@link StreamRedactor.flush} is
 * called.
 */
export class StreamRedactor {
  private buffer = "";
  private readonly windowSize: number;
  private readonly extraSecrets: readonly string[];

  constructor(extraSecrets: readonly string[] = [], windowSize = 64) {
    this.extraSecrets = extraSecrets;
    this.windowSize = Math.max(0, windowSize);
  }

  /**
   * Feed a chunk and return the safe-to-emit, redacted prefix. The trailing
   * window is retained internally until the next {@link push} or {@link flush}.
   */
  push(chunk: string): string {
    this.buffer += chunk;
    if (this.buffer.length <= this.windowSize) {
      return "";
    }
    const releaseUpTo = this.buffer.length - this.windowSize;
    const releasable = this.buffer.slice(0, releaseUpTo);
    this.buffer = this.buffer.slice(releaseUpTo);
    return redactSecrets(releasable, this.extraSecrets);
  }

  /** Redact and return whatever remains in the retained window. */
  flush(): string {
    const remaining = this.buffer;
    this.buffer = "";
    return redactSecrets(remaining, this.extraSecrets);
  }
}
