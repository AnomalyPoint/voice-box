// Thin fetch wrapper for the daemon's /v1 API.
//
// Auth: the page arrives with the token in the URL fragment, trades it for an
// HttpOnly cookie, and wipes the fragment. The token is also kept in
// sessionStorage so a 401 (rotated token aside, e.g. an expired cookie) can be
// healed with one re-auth instead of a dead panel.

const API = "/v1";
const TOKEN_KEY = "voicebox-token";

export class ApiError extends Error {
  constructor(message, status, code, hint) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

export function rememberToken(token) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage may be unavailable; re-auth just won't work */
  }
}

function storedToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Re-auth with the remembered token, if any. Returns true on success. */
export async function reauthenticate() {
  const token = storedToken();
  return token ? authenticate(token) : false;
}

/** Trade the token for the auth cookie. Returns true on success. */
export async function authenticate(token) {
  const response = await fetch(`${API}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "voice-box" },
    credentials: "same-origin",
    body: JSON.stringify({ token }),
  }).catch(() => null);
  return response?.ok ?? false;
}

export async function api(method, path, body, { retried = false } = {}) {
  const response = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", "x-requested-with": "voice-box" },
    credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 && !retried) {
    const token = storedToken();
    if (token && (await authenticate(token))) {
      return api(method, path, body, { retried: true });
    }
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* empty or non-JSON body */
  }

  if (!response.ok) {
    const detail = payload?.error;
    throw new ApiError(
      detail?.message ?? `Request failed (${response.status}).`,
      response.status,
      detail?.code ?? "unknown",
      detail?.hint,
    );
  }
  return payload;
}
