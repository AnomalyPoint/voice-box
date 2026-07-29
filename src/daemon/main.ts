import { createLogger, type Logger } from "../shared/log.js";
import { getPaths } from "../shared/paths.js";
import type { DaemonState } from "../shared/protocol.js";
import { errorMessage } from "../shared/errors.js";
import { resolveAudioPlayer, type AudioPlayer, type DetectionReport } from "./audio/index.js";
import { ConfigStore } from "./config/store.js";
import { AudioCache } from "./core/cache.js";
import { HistoryLog } from "./core/history.js";
import { AgentRegistry } from "./core/registry.js";
import { Scheduler } from "./core/scheduler.js";
import { Synthesizer } from "./core/synthesizer.js";
import { createRequestHandler } from "./http/server.js";
import { EventHub } from "./http/events.js";
import { buildRoutes } from "./http/routes.js";
import { buildPanelRoutes } from "./http/routes.panel.js";
import { claimDaemonRole, createDaemonState } from "./lifecycle.js";
import { ProviderRegistry } from "./providers/registry.js";

export interface DaemonContext {
  state: DaemonState;
  store: ConfigStore;
  providers: ProviderRegistry;
  registry: AgentRegistry;
  scheduler: Scheduler;
  synthesizer: Synthesizer;
  cache: AudioCache;
  history: HistoryLog;
  hub: EventHub;
  player: AudioPlayer;
  audioReport: DetectionReport;
  logger: Logger;
  requestShutdown(reason: string): void;
}

/**
 * Run the daemon in the foreground.
 *
 * Returns true when this process took the daemon role and is now serving, and
 * false when a healthy daemon already owned it. Losing the startup race is the
 * normal outcome when several agents launch at once, not an error -- the
 * caller should exit 0 rather than linger.
 */
export async function runDaemon(): Promise<boolean> {
  const logger = createLogger({ scope: "daemon" });
  const paths = getPaths();

  const store = await ConfigStore.load(paths);
  const providers = ProviderRegistry.create(store);
  const cache = new AudioCache(paths.cacheDir, logger);
  const synthesizer = new Synthesizer(providers, cache, logger);

  const { player, report } = await resolveAudioPlayer({
    logger,
    preferred: store.config.audio.backend,
    ...(store.config.audio.customCommand !== undefined
      ? { customCommand: store.config.audio.customCommand }
      : {}),
  });

  const registry = new AgentRegistry(store, providers, logger);
  const history = new HistoryLog(paths.historyFile, logger);
  const scheduler = new Scheduler({ store, registry, synthesizer, player, history, logger });

  const hub = new EventHub(logger, () => ({
    profiles: registry.listProfiles(),
    sessions: registry.listSessions(),
    queue: scheduler.snapshot(),
    audioBackend: player.backend,
  }));

  let shuttingDown = false;

  // Fully built before the socket is bound, so the handler never observes a
  // half-initialised state. claimDaemonRole mutates `state.port` as it settles.
  const state = createDaemonState(store.config.daemon.port);

  const context: DaemonContext = {
    state,
    store,
    providers,
    registry,
    scheduler,
    synthesizer,
    cache,
    history,
    hub,
    player,
    audioReport: report,
    logger,
    requestShutdown: (reason) => void shutdown(reason),
  };

  const handler = createRequestHandler({
    getToken: () => state.token,
    getPort: () => state.port,
    routes: [...buildRoutes(context), ...buildPanelRoutes(context)],
    logger,
  });

  const claim = await claimDaemonRole({
    handler,
    state,
    configuredPort: store.config.daemon.port,
    paths,
    logger,
  });

  if (!claim) {
    logger.info("another daemon is already running; nothing to do");
    return false;
  }

  scheduler.start();
  hub.start();
  void cache.prune();

  // Push every scheduler change to any open panel.
  scheduler.onChange(() => {
    hub.emit("queue", { queue: scheduler.snapshot(), profiles: registry.listProfiles() });
  });

  // Catch agents that died without saying goodbye, and drop their backlog so
  // a crashed session's queued lines do not play minutes later.
  const reaper = setInterval(() => {
    for (const session of registry.reapDeadSessions()) {
      logger.debug("agent process gone", { pid: session.pid });
      scheduler.onSessionEnd(session.profileId);
    }
  }, 10_000);
  reaper.unref();

  logger.info("voice box daemon ready", {
    url: `http://${claim.state.host}:${claim.state.port}`,
    audioBackend: player.backend.id,
    providers: providers.configured().map((provider) => provider.id),
  });
  if (report.available.length === 0) {
    logger.warn("no audio player found -- speech will not be audible");
  }

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { reason });
    try {
      hub.stop();
      await scheduler.stop();
      await claim?.release();
    } catch (error) {
      logger.debug("shutdown error", { error: errorMessage(error) });
    }
    process.exit(0);
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  return true;
}
