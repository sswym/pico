/**
 * Secret scanning — refuses to store content that looks like an API key,
 * token, or private key. Defense-in-depth against the LLM being tricked
 * into persisting credentials it sees in code or chat.
 *
 * Patterns are conservative: false positives (refusing legitimate text)
 * are preferable to false negatives (storing a real secret). When a fact
 * is rejected, the LLM gets the error and can re-add a redacted version.
 */

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "AWS access key", pattern: /(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/ },
  { name: "GitHub token", pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
  { name: "SSH private key", pattern: /-----BEGIN\s+(?:RSA\s+|OPENSSH\s+|EC\s+|DSA\s+)?PRIVATE\s+KEY-----/ },
  { name: "Stripe/OpenAI-style key", pattern: /\b(?:sk_live_|sk_test_|pk_live_|pk_test_)[A-Za-z0-9_-]{20,}/ },
  {
    name: "OpenAI-style key (sk- prefix)",
    // The bare `sk-` prefix is itself a strong signal, so it gets its own
    // pattern with a much lower continuation bound. The old combined pattern
    // required 20+ chars after the prefix and let short test keys slip
    // through (`sk-test-abcdef123456` — 17 chars — was stored verbatim).
    // False positives are preferable to false negatives here; 8 continuation
    // chars still lets "sk-100" / "sk-id" style non-secrets through.
    pattern: /\bsk-[A-Za-z0-9_-]{8,}/,
  },
  {
    name: "key=value secret",
    // Unquoted (`KEY = value`) and non-canonical spellings (`aws_secret_access_key`,
    // `GITHUB_TOKEN`) must not bypass the scan. Values require 8+ chars so
    // placeholder text like `api_key = xxx` is not refused.
    pattern:
      /['"]?(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|secret[_-]?access[_-]?key|auth[_-]?token|private[_-]?key|client[_-]?secret|github[_-]?token|token)['"]?\s*[:=]\s*(?:['"][^'"\s]{8,}['"]|\S{8,})/i,
  },
  {
    name: "camelCase credential",
    // camelCase spellings (`accessKey=`, `secretKey`, `apiToken`, `clientSecret`)
    // slipped past the kebab/snake regex above.
    pattern:
      /['"]?(?:accessKey|secretKey|apiToken|authToken|clientSecret|privateKey|apiKey)['"]?\s*[:=]\s*(?:['"][^'"\s]{8,}['"]|\S{8,})/,
  },
  // JSON Web Tokens — three dot-separated base64url segments.
  { name: "JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // Slack tokens
  { name: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  // Google API keys
  { name: "Google API key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
];

export interface SecretScanResult {
  blocked: boolean;
  reason?: string;
}

export function scanSecrets(content: string): SecretScanResult {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return {
        blocked: true,
        reason: `Possible ${name} detected — refusing to store. Redact the secret and try again.`,
      };
    }
  }
  return { blocked: false };
}
