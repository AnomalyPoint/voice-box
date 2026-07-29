/**
 * Thin wrapper over the daemon's HTTP API.
 *
 * Every mutating call carries X-Requested-With, which a cross-origin form post
 * cannot set without a CORS preflight the daemon never approves.
 */

const BASE = "/v1";

export class ApiError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export async function api(method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      "x-requested-with": "voice-box",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = payload && payload.error;
    throw new ApiError(
      (error && error.code) || "internal",
      (error && error.message) || `Request failed (${response.status})`,
      error && error.hint,
    );
  }
  return payload;
}

/**
 * Trade the token in the URL fragment for an HttpOnly cookie.
 *
 * The token travels in the fragment rather than the query string so it never
 * reaches server logs or a Referer header, and the fragment is wiped from the
 * address bar immediately afterwards.
 */
export async function establishSession() {
  const hash = window.location.hash || "";
  const match = /[#&]t=([^&]+)/.exec(hash);
  if (!match) return false;

  try {
    await api("POST", "/session", { token: decodeURIComponent(match[1]) });
    return true;
  } finally {
    history.replaceState(null, "", window.location.pathname);
  }
}
