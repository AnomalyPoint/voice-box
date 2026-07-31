import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { ZodTypeAny, output as ZodOutput } from "zod";

import { VoiceBoxError, toVoiceBoxError } from "../../shared/errors.js";
import type { Logger } from "../../shared/log.js";
import {
  API_PREFIX,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  type ErrorBody,
} from "../../shared/protocol.js";
import { hasAllowedOrigin, hasLoopbackHost, isAuthorized } from "./auth.js";
import { serveStatic } from "./static.js";

/** Cap request bodies well above any real utterance, far below memory pressure. */
const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Parse and validate the JSON body. Throws a typed error on mismatch. */
  body<S extends ZodTypeAny>(schema: S): Promise<ZodOutput<S>>;
}

/**
 * Returned by a handler that owns the response itself (SSE, file streaming).
 * Without it the router would try to serialise a body onto a stream that must
 * stay open.
 */
export const HANDLED = Symbol("voice-box:handled");

export type RouteHandler = (ctx: RequestContext) => Promise<unknown> | unknown;

export interface Route {
  method: string;
  /** Path under /v1, may contain :params, e.g. "/sessions/:id". */
  path: string;
  handler: RouteHandler;
  /** Skip bearer auth. Only /health qualifies. */
  public?: boolean;
}

export interface ServerOptions {
  /**
   * Read lazily: the handler is built before the port is bound, because
   * binding the port IS the daemon's lock, and the token/port are only final
   * once that succeeds.
   */
  getToken(): string;
  getPort(): number;
  routes: Route[];
  logger: Logger;
}

interface CompiledRoute extends Route {
  segments: string[];
}

export function createRequestHandler(options: ServerOptions): RequestListener {
  const { getToken, getPort, logger } = options;
  const routes: CompiledRoute[] = options.routes.map((route) => ({
    ...route,
    segments: route.path.split("/").filter(Boolean),
  }));

  return (req, res) => {
    void handle(req, res).catch((error) => {
      logger.error("unhandled request failure", { error });
      sendError(res, toVoiceBoxError(error));
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setTimeout(REQUEST_TIMEOUT_MS, () => res.destroy());
    applySecurityHeaders(res);

    // --- Anti-rebinding gate, before anything else looks at the request ----
    if (!hasLoopbackHost(req)) {
      sendError(res, new VoiceBoxError("invalid_input", "Invalid Host header."), 403);
      return;
    }
    if (!hasAllowedOrigin(req, getPort())) {
      sendError(res, new VoiceBoxError("invalid_input", "Cross-origin requests are refused."), 403);
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${getPort()}`);
    const method = (req.method ?? "GET").toUpperCase();

    if (!url.pathname.startsWith(API_PREFIX)) {
      // The control panel itself. Unauthenticated on purpose: the HTML and CSS
      // contain nothing sensitive, and the page exchanges its token for a
      // cookie before it can read any state.
      if (method === "GET" && (await serveStatic(url.pathname, res))) return;
      sendError(res, new VoiceBoxError("invalid_input", "Not found."), 404);
      return;
    }

    const pathname = url.pathname.slice(API_PREFIX.length) || "/";
    const match = matchRoute(routes, method, pathname);
    if (!match) {
      sendError(res, new VoiceBoxError("invalid_input", `No route for ${method} ${pathname}.`), 404);
      return;
    }

    if (!match.route.public) {
      if (!isAuthorized(req, getToken())) {
        sendError(res, new VoiceBoxError("invalid_input", "Unauthorized."), 401);
        return;
      }
      // A browser form post cannot set a custom header without a CORS
      // preflight, which we never approve -- so this proves intent.
      if (method !== "GET" && req.headers[REQUESTED_WITH_HEADER] !== REQUESTED_WITH_VALUE) {
        sendError(
          res,
          new VoiceBoxError("invalid_input", `Missing ${REQUESTED_WITH_HEADER} header.`),
          403,
        );
        return;
      }
    }

    const ctx: RequestContext = {
      req,
      res,
      url,
      params: match.params,
      body: async (schema) => {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = raw.length ? JSON.parse(raw) : {};
        } catch {
          throw new VoiceBoxError("invalid_input", "Request body is not valid JSON.");
        }
        const result = schema.safeParse(parsed);
        if (!result.success) {
          const summary = result.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
          throw new VoiceBoxError("invalid_input", `Invalid request -- ${summary}`);
        }
        return result.data;
      },
    };

    try {
      const payload = await match.route.handler(ctx);
      // A handler may own the response (SSE keeps it open forever).
      if (payload === HANDLED || res.writableEnded || res.headersSent) return;
      sendJson(res, payload ?? { ok: true });
    } catch (error) {
      const mapped = toVoiceBoxError(error);
      logger.debug("request failed", { method, pathname, code: mapped.code });
      sendError(res, mapped);
    }
  }
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // No permissive CORS headers are ever set: cross-origin reads must fail.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

function matchRoute(
  routes: CompiledRoute[],
  method: string,
  pathname: string,
): { route: CompiledRoute; params: Record<string, string> } | null {
  const parts = pathname.split("/").filter(Boolean);

  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < route.segments.length; i++) {
      const segment = route.segments[i] as string;
      const value = parts[i] as string;
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = decodeURIComponent(value);
      } else if (segment !== value) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        // Pause rather than destroy: TCP backpressure stops the sender while
        // the handler still gets to answer with a legible 413. Destroying here
        // resets the connection and the client sees no status at all.
        req.pause();
        reject(new VoiceBoxError("text_too_long", `Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const STATUS_BY_CODE: Partial<Record<string, number>> = {
  not_configured: 409,
  invalid_input: 400,
  unknown_session: 410,
  text_too_long: 413,
  provider_auth: 502,
  provider_rate_limit: 429,
  provider_error: 502,
  no_audio_backend: 503,
  playback_failed: 500,
  config_invalid: 500,
  daemon_unavailable: 503,
  internal: 500,
};

export function sendError(res: ServerResponse, error: VoiceBoxError, status?: number): void {
  if (res.writableEnded) return;
  const body: ErrorBody = { error: error.toJSON() };
  sendJson(res, body, status ?? STATUS_BY_CODE[error.code] ?? 500);
}
