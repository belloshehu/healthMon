import crypto from "crypto";

/**
 * Generates a unique 6-digit numeric patient code (100000 - 999999) for keypad entry.
 * - Never starts with 0 so 6 digits are always unambiguous on the 4x4 matrix keypad.
 * - Avoids trivial sequential or repeated patterns (e.g. 111111, 123456).
 * - Guarantees uniqueness against the hospital's historical issued codes set (codes are never reused).
 */
const DISALLOWED_PATTERNS = new Set([
  "111111",
  "222222",
  "333333",
  "444444",
  "555555",
  "666666",
  "777777",
  "888888",
  "999999",
  "123456",
  "654321",
  "100000",
]);

export function generateUniquePatientCode(
  existingCodesInHospital: ReadonlySet<string>,
  maxAttempts = 500
): string {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const num = crypto.randomInt(100000, 1000000);
    const code = String(num);

    if (DISALLOWED_PATTERNS.has(code)) {
      continue;
    }

    if (!existingCodesInHospital.has(code)) {
      return code;
    }
  }

  throw new Error(
    "Unable to allocate a unique 6-digit patient code after maximum attempts"
  );
}

/**
 * Generates an internal Firestore document ID for a patient that is completely distinct
 * from the 6-digit keypad code.
 */
export function generateInternalPatientId(): string {
  return `pat_${crypto.randomBytes(10).toString("hex")}`;
}
