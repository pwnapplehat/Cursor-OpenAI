import { timingSafeEqual } from "node:crypto";

/** Constant-time string comparison, safe for comparing secrets (bearer tokens, admin keys) against an expected value without leaking length/prefix-match timing. */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers so the overall
    // function takes roughly constant time regardless of the length
    // mismatch branch, rather than short-circuiting instantly.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
