import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "../../shared/log.js";

/** Proxies and sleeping laptops silently drop idle streams; a comment keeps it warm. */
const KEEPALIVE_MS = 20_000;

/** Replay buffer so a reconnecting client with Last-Event-ID can catch up. */
const REPLAY_LIMIT = 100;

export type EventType =
  | "snapshot"
  | "state"
  | "queue"
  | "history"
  | "config"
  | "diagnostics";

interface StoredEvent {
  seq: number;
  type: EventType;
  data: unknown;
}

/**
 * Server-sent events for the control panel.
 *
 * SSE rather than WebSocket: traffic here is overwhelmingly server-to-browser,
 * EventSource reconnects on its own with Last-Event-ID, and Node ships no
 * WebSocket server -- adding `ws` would be a dependency for no benefit.
 *
 * Nothing written here may contain a secret. Config events carry only
 * "configured: true" plus a masked hint, by construction.
 */
export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly recent: StoredEvent[] = [];
  private seq = 0;
  private keepalive: NodeJS.Timeout | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly buildSnapshot: () => unknown,
  ) {}

  start(): void {
    this.keepalive = setInterval(() => {
      for (const client of this.clients) client.write(": keepalive\n\n");
    }, KEEPALIVE_MS);
    this.keepalive.unref();
  }

  stop(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Attach a browser. Sends a full snapshot, then deltas. */
  subscribe(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    this.clients.add(res);
    this.logger.debug("panel connected", { clients: this.clients.size });

    // Replay anything missed across a brief disconnect, otherwise start fresh.
    const lastId = Number(req.headers["last-event-id"]);
    const missed = Number.isFinite(lastId)
      ? this.recent.filter((event) => event.seq > lastId)
      : [];

    if (missed.length > 0 && missed.length < REPLAY_LIMIT) {
      for (const event of missed) this.write(res, event);
    } else {
      this.write(res, { seq: ++this.seq, type: "snapshot", data: this.buildSnapshot() });
    }

    const drop = () => {
      this.clients.delete(res);
      this.logger.debug("panel disconnected", { clients: this.clients.size });
    };
    req.on("close", drop);
    req.on("error", drop);
  }

  emit(type: EventType, data: unknown): void {
    if (this.clients.size === 0) return;
    const event: StoredEvent = { seq: ++this.seq, type, data };

    this.recent.push(event);
    if (this.recent.length > REPLAY_LIMIT) this.recent.shift();

    for (const client of this.clients) this.write(client, event);
  }

  private write(res: ServerResponse, event: StoredEvent): void {
    try {
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }
}
