/** JWT expiry is a scheduling hint; session authority still comes from Redis. */
export function getTokenExpiry(session: { accessToken?: string; expiresAt?: number }): number | null {
  const expiries: number[] = [];
  if (typeof session.expiresAt === 'number' && Number.isFinite(session.expiresAt)) {
    expiries.push(session.expiresAt);
  }
  try {
    const parts = session.accessToken?.split('.');
    const payload = parts?.length === 3 ? parts[1] : undefined;
    if (payload) {
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
      if (typeof exp === 'number' && Number.isFinite(exp) && Number.isFinite(exp * 1000)) {
        expiries.push(exp * 1000);
      }
    }
  } catch {
    // Providers may issue opaque access tokens.
  }
  return expiries.length > 0 ? Math.min(...expiries) : null;
}
