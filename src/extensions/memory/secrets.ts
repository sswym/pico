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
  { name: "Stripe/OpenAI-style key", pattern: /\b(?:sk-|sk_live_|sk_test_|pk_live_|pk_test_)[A-Za-z0-9_-]{20,}/ },
  {
    name: "key=value secret",
    pattern: /['"]?(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|auth[_-]?token|private[_-]?key|client[_-]?secret)['"]?\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
  },
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
