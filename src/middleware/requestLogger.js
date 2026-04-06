/**
 * Middleware de log estruturado de requisições.
 *
 * Salva no Redis:
 *   gateway:logs                           → lista circular das últimas 500 req
 *   gateway:stats:{service}:processed      → contador total acumulado
 *   gateway:stats:{service}:errors         → erros totais acumulados
 *   gateway:daily:{service}:{YYYY-MM-DD}   → contador diário (TTL 8 dias)
 */

const { randomUUID } = require("crypto");
const { getClient } = require("../redis");
const emitter = require("../events/emitter");

const REDIS_KEY = "gateway:logs";
const MAX_LOGS = 500;
const DAILY_TTL_SECONDS = 8 * 24 * 60 * 60; // 8 dias → 7 dias de histórico visível

// Mapeamento explícito: prefixo de rota → nome do serviço no Redis.
// Garante que "gateway:daily:bling:..." seja incrementado corretamente
// independente de como o path muda após o mount do proxy.
const SERVICE_PREFIXES = [
  { prefix: "/bling",          service: "bling" },
  { prefix: "/melhorenvio",    service: "melhorenvio" },
  { prefix: "/melhorrastreio", service: "melhorrastreio" },
];

function detectService(path) {
  for (const { prefix, service } of SERVICE_PREFIXES) {
    if (path.startsWith(prefix)) return service;
  }
  // Fallback: primeiro segmento (para rotas não mapeadas explicitamente)
  const match = path.match(/^\/([^/]+)/);
  return match ? match[1].toLowerCase() : "unknown";
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD em UTC
}

function requestLogger(req, res, next) {
  if (req.path === "/health" || req.path.startsWith("/admin")) {
    return next();
  }

  const start = Date.now();
  const id = randomUUID();

  res.on("finish", async () => {
    const durationMs = Date.now() - start;
    const resolvedPath = req.originalUrl || req.path;
    const service = detectService(resolvedPath);
    const cached = res.getHeader("X-Cache") === "HIT";
    const isError = res.statusCode >= 400;

    const entry = {
      id,
      service,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      timestamp: new Date().toISOString(),
      cached,
    };

    emitter.emit("request", entry);

    const redis = getClient();
    if (redis) {
      try {
        const json = JSON.stringify(entry);
        const dailyKey = `gateway:daily:${service}:${todayKey()}`;

        const pipeline = redis.pipeline();

        // Log circular
        pipeline.lpush(REDIS_KEY, json);
        pipeline.ltrim(REDIS_KEY, 0, MAX_LOGS - 1);

        // Contadores totais acumulados
        pipeline.incr(`gateway:stats:${service}:processed`);
        if (isError) pipeline.incr(`gateway:stats:${service}:errors`);

        // Contador diário (expira em 8 dias para manter 7 dias de histórico)
        pipeline.incr(dailyKey);
        pipeline.expire(dailyKey, DAILY_TTL_SECONDS);

        await pipeline.exec();
      } catch (err) {
        console.error("[REQUEST LOGGER] Falha ao salvar no Redis:", err.message);
      }
    }
  });

  next();
}

module.exports = requestLogger;
