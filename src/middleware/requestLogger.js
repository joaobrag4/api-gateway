/**
 * Middleware de log estruturado de requisições.
 *
 * Intercepta todas as requests e, ao finalizar a resposta, salva um registro
 * estruturado no Redis (gateway:logs, últimas 500 entradas) e emite evento
 * para o stream SSE.
 *
 * Modo degradado: se Redis indisponível, apenas emite o evento em memória
 * (SSE ainda funciona, mas logs não sobrevivem a restarts).
 */

const { randomUUID } = require("crypto");
const { getClient } = require("../redis");
const emitter = require("../events/emitter");

const REDIS_KEY = "gateway:logs";
const MAX_LOGS = 500;

// Detecta o serviço a partir do path (ex: /bling/... → "bling")
function detectService(path) {
  const match = path.match(/^\/([^/]+)/);
  return match ? match[1] : "unknown";
}

function requestLogger(req, res, next) {
  // Ignora health check e rotas admin para não poluir os logs
  if (req.path === "/health" || req.path.startsWith("/admin")) {
    return next();
  }

  const start = Date.now();
  const id = randomUUID();

  res.on("finish", async () => {
    const durationMs = Date.now() - start;
    const service = detectService(req.path);

    // Detecta se foi servido do cache (o middleware de cache adiciona este header)
    const cached = res.getHeader("X-Cache") === "HIT";

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

    // Emite para clientes SSE em tempo real
    emitter.emit("request", entry);

    // Persiste no Redis
    const redis = getClient();
    if (redis) {
      try {
        const json = JSON.stringify(entry);
        const pipeline = redis.pipeline();
        pipeline.lpush(REDIS_KEY, json);
        pipeline.ltrim(REDIS_KEY, 0, MAX_LOGS - 1);
        // Incrementa contadores de stats por serviço
        pipeline.incr(`gateway:stats:${service}:processed`);
        if (res.statusCode >= 400) {
          pipeline.incr(`gateway:stats:${service}:errors`);
        }
        await pipeline.exec();
      } catch (err) {
        console.error("[REQUEST LOGGER] Falha ao salvar no Redis:", err.message);
      }
    }
  });

  next();
}

module.exports = requestLogger;
