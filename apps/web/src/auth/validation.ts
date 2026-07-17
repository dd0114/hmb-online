/**
 * Client-side pre-check mirroring the server pattern
 * (openapi.yaml components.schemas.LoginRequest.properties.nickname.pattern).
 * The server remains the source of truth for validation — this only avoids a
 * round-trip for obviously-invalid input.
 */
const NICKNAME_PATTERN = /^[\p{L}\p{N}_-]{2,16}$/u;

export function isValidNickname(nickname: string): boolean {
  return NICKNAME_PATTERN.test(nickname);
}
