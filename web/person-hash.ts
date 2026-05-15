// Identifier hashing — see docs/frontend-spec.md § Identifier hashing (normative).
//
// The server re-derives `person_hash` from the uploaded name and rejects the
// upload on mismatch. `normalize()` MUST stay byte-identical with the server's
// implementation and with the design doc. Any drift here surfaces as a 400 for
// every user.

export function normalize(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "");
}

export async function personHash(
  department: string,
  name: string,
): Promise<string> {
  const input = `${department}|${normalize(name)}`;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
