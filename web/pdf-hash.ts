// SHA-256 of the raw PDF bytes. The server re-verifies this against the `pdf`
// part of the multipart upload — see docs/frontend-spec.md § Outputs.

export async function pdfHash(bytes: Uint8Array): Promise<string> {
  // Cast: TS's lib types want ArrayBufferView<ArrayBuffer> but
  // `Uint8Array<ArrayBufferLike>` is runtime-compatible.
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
