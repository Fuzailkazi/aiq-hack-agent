import { describe, expect, it } from "vitest";
import { loadSignatures } from "../../src/config";
import { SecretRedactor } from "../../src/digest/armoriq/secrets";

const REDACTOR = SecretRedactor.fromSignatures(loadSignatures("config/armoriq_signatures.yaml"));

describe("SecretRedactor", () => {
  it.each(["ak_live_9f8e7d6c5b4a3210ffee", "ak_test_ABCdef0123456789", "ak_claw_x1y2z3w4v5u6-q_r"])(
    "finds and redacts real ArmorIQ key %s",
    (key) => {
      const text = `client = ArmorIQClient(api_key="${key}")`;
      expect(REDACTOR.armoriqKeys(text)).toEqual(new Set([key]));
      const redacted = REDACTOR.redact(text);
      expect(redacted).not.toContain(key);
      expect(redacted).toContain(`ak_****${key.slice(-4)}`);
      expect(REDACTOR.isRealArmoriqKey(key)).toBe(true);
    },
  );

  it.each(["ak_live_your_key_here", "ak_test_xxxxxxxxxxxx", "ak_live_<YOUR_KEY>"])(
    "treats %s as a placeholder",
    (value) => {
      expect(REDACTOR.armoriqKeys(`ARMORIQ_API_KEY=${value}`).size).toBe(0);
      expect(REDACTOR.isRealArmoriqKey(value)).toBe(false);
    },
  );

  it.each([
    "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789",
    "ghp_0123456789abcdefghijABCDEFGHIJ012345",
    "AKIAIOSFODNN7EXAMPLE",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv",
  ])("redacts other provider secret %s", (secret) => {
    expect(REDACTOR.redact(`token = '${secret}'`)).not.toContain(secret);
  });
});
