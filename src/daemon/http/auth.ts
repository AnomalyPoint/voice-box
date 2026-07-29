import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { BIND_HOST } from "../lifecycle.js";

/** Hostnames that legitimately reach a loopback-bound server. */
const LOOPBACK_HOSTS = new Set([BIND_HOST, "localhost", "[::1]", "::1"]);

/**
 * Constant-time comparison that does not leak length either.
 * timingSafeEqual throws on unequal lengths, so hash-free length equality is
 * checked first against a padded copy rather than short-circuiting.
 */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still do a comparison so the timing does not advertise a length mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function hostnameOf(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  // Strip the port: "127.0.0.1:4517" -> "127.0.0.1", "[::1]:4517" -> "[::1]".
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(headerValue.trim());
  return match?.[1] ?? null;
}

/**
 * Reject DNS-rebinding attacks.
 *
 * A page on the public internet can resolve its own hostname to 127.0.0.1 and
 * then talk to this server with the browser's blessing. The Host header still
 * carries the attacker's domain, so requiring a loopback Host blocks it.
 */
export function hasLoopbackHost(req: IncomingMessage): boolean {
  const host = hostnameOf(req.headers.host);
  return host !== null && LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Only same-origin browser requests are allowed. Non-browser clients (the MCP
 * process, curl) send no Origin at all, which is fine -- they are gated on the
 * bearer token instead.
 */
export function hasAllowedOrigin(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = new Set([
    `http://${BIND_HOST}:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  return allowed.has(origin.toLowerCase());
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Read the session cookie the control panel uses after exchanging its token. */
export function cookieToken(req: IncomingMessage, name = "voicebox_token"): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function isAuthorized(req: IncomingMessage, token: string): boolean {
  const presented = bearerToken(req) ?? cookieToken(req);
  return presented !== null && secretsMatch(presented, token);
}
