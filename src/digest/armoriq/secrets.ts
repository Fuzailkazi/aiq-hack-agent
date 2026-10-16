/** Finds ArmorIQ keys (ignoring obvious placeholders) and redacts them plus common provider secrets. */
import type { Signatures } from "../../config";

export const DEFAULT_ARMORIQ_KEY = String.raw`ak_(?:live|test|claw)_[A-Za-z0-9_\-]{8,}`;
export const DEFAULT_OTHER_SECRETS = [
  String.raw`sk-[A-Za-z0-9_\-]{20,}`,
  String.raw`gh[pousr]_[A-Za-z0-9]{30,}`,
  String.raw`github_pat_[A-Za-z0-9_]{30,}`,
  String.raw`AKIA[0-9A-Z]{16}`,
  String.raw`AIza[0-9A-Za-z_\-]{35}`,
  String.raw`xox[abprs]-[A-Za-z0-9\-]{10,}`,
];
export const DEFAULT_PLACEHOLDERS = [
  "your",
  "key",
  "here",
  "example",
  "placeholder",
  "changeme",
  "dummy",
  "sample",
  "redacted",
];

export const redactSecret = (secret: string): string => `${secret.slice(0, 3)}****${secret.slice(-4)}`;

export class SecretRedactor {
  /** Every ak_... token; each is then checked against the real-key pattern and placeholder rules. */
  private readonly candidate = /ak_[A-Za-z0-9_<>*-]+/g;
  private readonly armoriqFull: RegExp;
  private readonly other: RegExp | null;
  private readonly placeholders: Set<string>;

  constructor(
    armoriqPattern: string = DEFAULT_ARMORIQ_KEY,
    otherPatterns: string[] = DEFAULT_OTHER_SECRETS,
    placeholderMarkers: string[] = DEFAULT_PLACEHOLDERS,
  ) {
    this.armoriqFull = new RegExp(`^(?:${armoriqPattern})$`);
    this.other = otherPatterns.length
      ? new RegExp(otherPatterns.map((p) => `(?:${p})`).join("|"), "g")
      : null;
    this.placeholders = new Set(placeholderMarkers.map((m) => m.toLowerCase()));
  }

  static fromSignatures(sig: Signatures): SecretRedactor {
    return new SecretRedactor(sig.realKeyPattern, sig.otherSecretPatterns, sig.placeholderMarkers);
  }

  isRealArmoriqKey(value: string): boolean {
    if (!this.armoriqFull.test(value) || value.includes("<") || value.includes("*")) return false;
    // Placeholders are whole words ("ak_live_your_key_here") or x-runs ("ak_test_xxxxxxxx");
    // random key material is not split into such tokens.
    const tokens = value
      .split(/[_-]/)
      .slice(2)
      .filter(Boolean)
      .map((t) => t.toLowerCase());
    return !tokens.some((t) => this.placeholders.has(t) || (t.length >= 3 && /^x+$/.test(t)));
  }

  armoriqKeys(text: string): Set<string> {
    return new Set((text.match(this.candidate) ?? []).filter((k) => this.isRealArmoriqKey(k)));
  }

  redact(text: string): string {
    let out = text.replace(this.candidate, (m) => (this.isRealArmoriqKey(m) ? redactSecret(m) : m));
    if (this.other) out = out.replace(this.other, (m) => redactSecret(m));
    return out;
  }
}

/** Redact every string inside a JSON-like value (digests, LLM findings) before it is stored or shown. */
export function redactDeep<T>(value: T, redactor: SecretRedactor = new SecretRedactor()): T {
  if (typeof value === "string") return redactor.redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redactor)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redactor)])) as T;
  return value;
}
