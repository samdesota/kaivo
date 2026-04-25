/**
 * Identity bearer token. Lives in its own module (no other imports) so the
 * remote-log transport can read it without pulling in the identity client,
 * which itself depends on the logger — that round-trip would otherwise be
 * a circular import.
 */
let identityToken: string | null = null

export function setIdentityToken(tok: string | null): void {
  identityToken = tok
}

export function getIdentityToken(): string | null {
  return identityToken
}
