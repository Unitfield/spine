const AUTH_FLOW_PATHS = new Set(['/auth/login', '/auth/callback', '/auth/logout']);

function isAuthFlowPath(path: string): boolean {
  const normalized = path.split('#')[0].split('?')[0].replace(/\/+$/, '') || '/';
  return AUTH_FLOW_PATHS.has(normalized);
}

function hasUnsafeAuthorityPrefix(value: string): boolean {
  const normalized = value.trimStart();
  return (
    normalized.startsWith('//') ||
    normalized.startsWith('/\\') ||
    normalized.startsWith('\\')
  );
}

function hasUnsafeEncodedAuthorityPrefix(value: string): boolean {
  const queryOrFragmentIndex = value.search(/[?#]/);
  let decoded = queryOrFragmentIndex === -1
    ? value
    : value.slice(0, queryOrFragmentIndex);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (hasUnsafeAuthorityPrefix(decoded)) {
      return true;
    }

    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        return false;
      }
      decoded = next;
    } catch {
      return true;
    }
  }

  return hasUnsafeAuthorityPrefix(decoded);
}

/**
 * Normalize a post-authentication destination to a path on the current origin.
 *
 * Local paths and same-origin absolute URLs are supported for compatibility.
 * Network-path references, backslash authority variants, encoded authority
 * variants, non-HTTP schemes, and authentication loop targets are rejected.
 */
export function sanitizeOAuthReturnUrl(
  returnUrl: string | null | undefined,
  request: Request,
): string | null {
  if (!returnUrl || hasUnsafeEncodedAuthorityPrefix(returnUrl)) {
    return null;
  }

  try {
    const requestOrigin = new URL(request.url).origin;
    const isLocalPath = returnUrl.startsWith('/') && !returnUrl.startsWith('//');
    const candidateUrl = isLocalPath
      ? new URL(returnUrl, requestOrigin)
      : new URL(returnUrl);

    if (candidateUrl.origin !== requestOrigin) {
      return null;
    }

    const safePath = `${candidateUrl.pathname}${candidateUrl.search}${candidateUrl.hash}`;
    return isAuthFlowPath(safePath) ? null : safePath;
  } catch {
    return null;
  }
}

type TemporaryAuthCookieOptions = {
  maxAge: number;
};

/** Serialize a short-lived, server-only authentication cookie. */
export function serializeTemporaryAuthCookie(
  name: string,
  value: string,
  options: TemporaryAuthCookieOptions,
): string {
  const segments = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAge}`,
  ];

  if (process.env.NODE_ENV === 'production') {
    segments.push('Secure');
  }

  return segments.join('; ');
}
