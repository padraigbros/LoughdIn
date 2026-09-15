/**
 * A single-use nonce for Google ID-token sign-in. Supabase Auth compares the
 * token's nonce claim with the SHA-256 hex digest of the value it is given, so
 * Google receives the digest and Supabase receives the raw value.
 */
export async function createGoogleNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = btoa(String.fromCharCode(...bytes));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return {raw, hashed};
}
