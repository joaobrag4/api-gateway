/**
 * Rotas de administração do gateway — acessadas pelo Ziva OS.
 *
 * Todas protegidas por X-Admin-Key (middleware adminAuth no index.js).
 *
 * GET /admin/health    — status geral + Redis + uptime
 * GET /admin/services  — lista de serviços configurados
 * GET /admin/logs      — últimas N requisições (padrão: 100)
 * GET /admin/stats     — contadores agregados por serviço
 * GET /admin/stream    — SSE: eventos em tempo real
 */

const { Router } = require("express");
const { getClient } = require("../redis");
const emitter = require("../events/emitter");
const API_CONFIGS = require("../config/apis.js");

const router = Router();
const REDIS_KEY = "gateway:logs";

// ─── Health ───────────────────────────────────────────────────────────────────
router.get("/health", async (req, res) => {
  const redis = getClient();
  let redisStatus = "desconectado";
  let redisPingMs = null;

  if (redis) {
    try {
      const start = Date.now();
      await redis.ping();
      redisPingMs = Date.now() - start;
      redisStatus = "ok";
    } catch {
      redisStatus = "erro";
    }
  }

  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    redis: { status: redisStatus, pingMs: redisPingMs },
  });
});

// ─── Services ─────────────────────────────────────────────────────────────────
router.get("/services", async (req, res) => {
  const redis = getClient();
  const services = [];

  for (const [key, cfg] of Object.entries(API_CONFIGS)) {
    // Tenta buscar stats do Redis (contadores incrementados pelo requestLogger)
    let processed = 0;
    let errors = 0;

    if (redis) {
      try {
        processed = parseInt((await redis.get(`gateway:stats:${key}:processed`)) || "0", 10);
        errors     = parseInt((await redis.get(`gateway:stats:${key}:errors`))    || "0", 10);
      } catch { /* ignora */ }
    }

    services.push({
      name: key,
      label: cfg.name,
      baseUrl: cfg.baseUrl,
      rateLimit: {
        maxRequests: cfg.rateLimiter.reservoir,
        windowMs: cfg.rateLimiter.reservoirRefreshInterval,
      },
      stats: { processed, errors },
    });
  }

  res.json({ services });
});

// ─── Logs ─────────────────────────────────────────────────────────────────────
router.get("/logs", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
  const redis = getClient();

  if (!redis) {
    return res.json({ logs: [], message: "Redis indisponível — logs não persistidos" });
  }

  try {
    const raw = await redis.lrange(REDIS_KEY, 0, limit - 1);
    const logs = raw.map((entry) => {
      try { return JSON.parse(entry); } catch { return null; }
    }).filter(Boolean);

    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: "Falha ao buscar logs", details: err.message });
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  const redis = getClient();

  if (!redis) {
    return res.json({
      totalRequests: 0,
      totalErrors: 0,
      uptime: Math.floor(process.uptime()),
      message: "Redis indisponível — estatísticas não disponíveis",
    });
  }

  try {
    // Agrega contadores de todos os serviços
    let totalRequests = 0;
    let totalErrors = 0;
    const byService = {};

    for (const key of Object.keys(API_CONFIGS)) {
      const processed = parseInt((await redis.get(`gateway:stats:${key}:processed`)) || "0", 10);
      const errors    = parseInt((await redis.get(`gateway:stats:${key}:errors`))    || "0", 10);
      totalRequests += processed;
      totalErrors   += errors;
      byService[key] = { processed, errors };
    }

    res.json({
      totalRequests,
      totalErrors,
      uptime: Math.floor(process.uptime()),
      byService,
    });
  } catch (err) {
    res.status(500).json({ error: "Falha ao buscar stats", details: err.message });
  }
});

// ─── SSE Stream ───────────────────────────────────────────────────────────────
router.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  // Envia um comentário inicial para confirmar a conexão
  res.write(": connected\n\n");

  // Ping a cada 30s para manter a conexão viva
  const ping = setInterval(() => res.write(": ping\n\n"), 30_000);

  const onRequest = (entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  emitter.on("request", onRequest);

  req.on("close", () => {
    clearInterval(ping);
    emitter.off("request", onRequest);
  });
});

module.exports = router;
