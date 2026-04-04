/**
 * Rotas de administração do gateway — acessadas pelo Ziva OS.
 *
 * Todas protegidas por X-Admin-Key (middleware adminAuth no index.js).
 *
 * GET  /admin/health          — status + Redis + uptime
 * GET  /admin/services        — serviços configurados + stats em tempo real
 * PUT  /admin/services/:name  — atualiza rate limit de um serviço (persiste no Redis)
 * GET  /admin/logs            — últimas N requisições
 * GET  /admin/stats           — contadores totais por serviço
 * GET  /admin/stats/daily     — uso diário + histórico 7 dias + % do limite
 * GET  /admin/stream          — SSE em tempo real
 */

const { Router } = require("express");
const { getClient } = require("../redis");
const emitter = require("../events/emitter");
const API_CONFIGS = require("../config/apis.js");

const router = Router();
const REDIS_KEY = "gateway:logs";

// ─── Health ────────────────────────────────────────────────────────────────────
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

// ─── Services: lista ──────────────────────────────────────────────────────────
router.get("/services", async (req, res) => {
  const redis = getClient();
  const services = [];

  for (const [key, cfg] of Object.entries(API_CONFIGS)) {
    let processed = 0;
    let errors = 0;
    let rateLimitOverride = null;

    if (redis) {
      try {
        processed = parseInt((await redis.get(`gateway:stats:${key}:processed`)) || "0", 10);
        errors    = parseInt((await redis.get(`gateway:stats:${key}:errors`))    || "0", 10);

        // Carrega override de rate limit salvo pelo PUT
        const overrideRaw = await redis.get(`gateway:config:${key}:ratelimit`);
        if (overrideRaw) rateLimitOverride = JSON.parse(overrideRaw);
      } catch { /* ignora */ }
    }

    const rateLimit = rateLimitOverride ?? {
      maxRequests: cfg.rateLimiter.reservoir,
      windowMs: cfg.rateLimiter.reservoirRefreshInterval,
    };

    services.push({
      name: key,
      label: cfg.name,
      baseUrl: cfg.baseUrl,
      dailyLimit: cfg.dailyLimit ?? null,
      rateLimit,
      stats: { processed, errors },
    });
  }

  res.json({ services });
});

// ─── Services: atualiza rate limit ────────────────────────────────────────────
router.put("/services/:name", async (req, res) => {
  const { name } = req.params;

  if (!API_CONFIGS[name]) {
    return res.status(404).json({
      error: "Serviço não encontrado",
      message: `Serviço "${name}" não está configurado neste gateway`,
      servicos: Object.keys(API_CONFIGS),
    });
  }

  // Body foi capturado como raw Buffer pelo express.raw() — precisa parsear
  let body = {};
  try {
    const raw = req.body;
    if (Buffer.isBuffer(raw) && raw.length > 0) {
      body = JSON.parse(raw.toString("utf8"));
    }
  } catch {
    return res.status(400).json({ error: "Body JSON inválido" });
  }

  const { maxRequests, windowMs } = body;

  if (
    (maxRequests !== undefined && (typeof maxRequests !== "number" || maxRequests < 1)) ||
    (windowMs    !== undefined && (typeof windowMs    !== "number" || windowMs    < 100))
  ) {
    return res.status(400).json({
      error: "Parâmetros inválidos",
      message: "maxRequests (>= 1) e windowMs (>= 100) devem ser números positivos",
    });
  }

  const current = {
    maxRequests: API_CONFIGS[name].rateLimiter.reservoir,
    windowMs: API_CONFIGS[name].rateLimiter.reservoirRefreshInterval,
  };

  const updated = {
    maxRequests: maxRequests ?? current.maxRequests,
    windowMs:    windowMs    ?? current.windowMs,
  };

  // Persiste no Redis para sobreviver a restarts (lido pelo GET /services)
  const redis = getClient();
  if (redis) {
    try {
      await redis.set(`gateway:config:${name}:ratelimit`, JSON.stringify(updated));
    } catch (err) {
      console.error("[ADMIN] Falha ao salvar override no Redis:", err.message);
    }
  }

  console.log(`[ADMIN] Rate limit de "${name}" atualizado:`, updated);

  res.json({
    ok: true,
    service: name,
    rateLimit: updated,
    note: "Configuração salva no Redis. O rate limiter ativo só muda após reinício do processo — use as env vars BLING_MAX_REQUESTS e BLING_WINDOW_MS no Railway para mudanças imediatas.",
  });
});

// ─── Logs ─────────────────────────────────────────────────────────────────────
router.get("/logs", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
  const redis = getClient();

  if (!redis) {
    return res.json({ logs: [], message: "Redis indisponível" });
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

// ─── Stats totais ─────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  const redis = getClient();

  if (!redis) {
    return res.json({ totalRequests: 0, totalErrors: 0, uptime: Math.floor(process.uptime()) });
  }

  try {
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

    res.json({ totalRequests, totalErrors, uptime: Math.floor(process.uptime()), byService });
  } catch (err) {
    res.status(500).json({ error: "Falha ao buscar stats", details: err.message });
  }
});

// ─── Stats diários — uso + histórico 7 dias ───────────────────────────────────
router.get("/stats/daily", async (req, res) => {
  const redis = getClient();

  if (!redis) {
    return res.json({ services: {}, message: "Redis indisponível" });
  }

  try {
    const result = {};

    for (const [key, cfg] of Object.entries(API_CONFIGS)) {
      const dailyLimit = cfg.dailyLimit ?? null;
      const history = [];

      // Busca os últimos 7 dias
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - i);
        const dateStr = date.toISOString().slice(0, 10);

        const count = parseInt(
          (await redis.get(`gateway:daily:${key}:${dateStr}`)) || "0",
          10
        );

        const percent = dailyLimit ? parseFloat(((count / dailyLimit) * 100).toFixed(2)) : null;

        history.push({ date: dateStr, count, percent });
      }

      const today = history[0];

      result[key] = {
        label: cfg.name,
        dailyLimit,
        today: today.count,
        todayPercent: today.percent,
        history, // índice 0 = hoje, 1 = ontem, ...
      };
    }

    res.json({ services: result, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: "Falha ao buscar stats diários", details: err.message });
  }
});

// ─── SSE Stream ───────────────────────────────────────────────────────────────
router.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  res.write(": connected\n\n");

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

// ─── (token management removido — gerenciado pelo Ziva OS) ───────────────────

/**
 * GET /admin/mr/token-status — mantido apenas para compatibilidade, retorna vazio
 * @deprecated Use o Ziva OS para gerenciar tokens de integração
 */
router.get("/mr/token-status", async (req, res) => {
  const redis = getClient();
  if (!redis) return res.json({ cached: false, reason: "Redis indisponível" });

  try {
    const [token, ttl] = await Promise.all([
      redis.get("gateway:mr:access_token"),
      redis.ttl("gateway:mr:access_token"),
    ]);
    const hasRefresh = !!(await redis.exists("gateway:mr:refresh_token"));

    if (!token) return res.json({ cached: false, hasRefresh });

    // Tenta decodificar o JWT para pegar email e exp
    let email = null;
    let exp   = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
      email = payload.email || payload.preferred_username || null;
      exp   = payload.exp   || null;
    } catch { /* ignora */ }

    res.json({ cached: true, ttlSeconds: ttl, hasRefresh, email, exp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/mr/token
 * Injeta manualmente um accessToken (e opcionalmente refreshToken) no Redis.
 * Body: { accessToken: string, refreshToken?: string, expiresInDays?: number }
 */
router.post("/mr/token", async (req, res) => {
  const redis = getClient();
  if (!redis) return res.status(503).json({ error: "Redis não disponível" });

  let body = req.body;
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString()); } catch {
      return res.status(400).json({ error: "Body inválido — envie JSON" });
    }
  }

  const { accessToken, refreshToken, expiresInDays = 28 } = body;
  if (!accessToken) return res.status(400).json({ error: "accessToken obrigatório" });

  const ttl         = Math.floor(expiresInDays * 24 * 60 * 60);
  const refreshTtl  = 55 * 24 * 60 * 60;

  await redis.set("gateway:mr:access_token", accessToken, "EX", ttl);
  if (refreshToken) {
    await redis.set("gateway:mr:refresh_token", refreshToken, "EX", refreshTtl);
  }

  // Decodifica para confirmar email/exp
  let email = null;
  let exp   = null;
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64").toString());
    email = payload.email || payload.preferred_username || null;
    exp   = payload.exp   || null;
  } catch { /* ignora */ }

  res.json({ ok: true, email, exp, expiresInDays, hasRefresh: !!refreshToken });
});

module.exports = router;
