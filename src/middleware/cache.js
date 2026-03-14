/**
 * Middleware de Cache de respostas GET via Redis.
 *
 * ─── Como funciona ───────────────────────────────────────────────────────────
 *
 * 1. Requisição GET chega → verifica se a chave existe no Redis
 *    - HIT  → retorna o JSON cacheado imediatamente (< 5ms), sem ir ao Bling
 *    - MISS → deixa a requisição continuar normalmente
 *
 * 2. Quando a resposta do Bling chega com status 200:
 *    → salva o JSON no Redis com TTL de 5 minutos
 *
 * 3. Em operações de escrita bem-sucedidas (POST, PUT, PATCH, DELETE):
 *    → o proxy chama `invalidate()` para limpar o cache do recurso alterado
 *
 * ─── O que NÃO é cacheado ────────────────────────────────────────────────────
 *  • Respostas com status != 200 (erros, redirects, etc.)
 *  • Requisições com método != GET ou HEAD
 *  • Qualquer requisição quando Redis está indisponível (passa direto)
 *
 * ─── Chave do cache ──────────────────────────────────────────────────────────
 *  gateway:cache:<prefix>:<path>:<querystring-json>
 *  Ex: gateway:cache:bling:/Api/v3/pedidos/vendas/123:{}
 */

const { getClient } = require("../redis");

const CACHE_TTL_SECONDS = 300; // 5 minutos

/**
 * Fábrica do middleware de cache.
 *
 * @param {string} prefix - Prefixo para namespacing no Redis (ex: "bling")
 * @returns {Function}    - Middleware Express
 */
function cache(prefix) {
  return async (req, res, next) => {
    // Só aplica cache em GET e HEAD
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    const redis = getClient();
    if (!redis) return next(); // Redis indisponível → passa direto, sem cache

    const cacheKey = buildKey(prefix, req.path, req.query);

    try {
      const cached = await redis.get(cacheKey);

      if (cached) {
        console.log(`[CACHE] ✅ HIT  — ${req.method} ${req.path}`);
        res.set("X-Cache", "HIT");
        res.set("X-Cache-TTL", await redis.ttl(cacheKey));
        return res.status(200).json(JSON.parse(cached));
      }
    } catch (err) {
      // Falha de leitura do Redis não deve derrubar a requisição
      console.warn(`[CACHE] ⚠️  Erro ao ler chave "${cacheKey}": ${err.message}`);
    }

    // MISS: intercepta res.json para salvar a resposta antes de enviá-la
    const originalJson = res.json.bind(res);
    res.json = async function (body) {
      res.set("X-Cache", "MISS");

      // Só cacheia respostas 200 com corpo presente
      if (res.statusCode === 200 && body != null) {
        try {
          await redis.set(
            cacheKey,
            JSON.stringify(body),
            "EX",
            CACHE_TTL_SECONDS
          );
          console.log(
            `[CACHE] 💾 Salvo — ${req.method} ${req.path} (TTL: ${CACHE_TTL_SECONDS}s)`
          );
        } catch (err) {
          console.warn(
            `[CACHE] ⚠️  Erro ao salvar chave "${cacheKey}": ${err.message}`
          );
        }
      }

      return originalJson(body);
    };

    console.log(`[CACHE] ❌ MISS — ${req.method} ${req.path}`);
    next();
  };
}

/**
 * Invalida todas as entradas de cache de um prefix + path no Redis.
 *
 * Chamado automaticamente pelo proxy após operações de escrita bem-sucedidas
 * (POST, PUT, PATCH, DELETE) para garantir consistência dos dados.
 *
 * @param {string} prefix - Prefixo do namespace (ex: "bling")
 * @param {string} path   - Caminho do recurso alterado (ex: "/Api/v3/pedidos/vendas/123")
 */
async function invalidate(prefix, path) {
  const redis = getClient();
  if (!redis) return;

  try {
    // Usa SCAN em vez de KEYS para não bloquear o Redis em produção
    const pattern = `gateway:cache:${prefix}:${path}*`;
    const keys = await scanKeys(redis, pattern);

    if (keys.length === 0) return;

    await redis.del(...keys);
    console.log(
      `[CACHE] 🗑️  Invalidadas ${keys.length} entradas para "${path}"`
    );
  } catch (err) {
    console.warn(`[CACHE] ⚠️  Erro ao invalidar cache para "${path}": ${err.message}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildKey(prefix, path, query) {
  const queryStr = Object.keys(query).length > 0 ? JSON.stringify(query) : "{}";
  return `gateway:cache:${prefix}:${path}:${queryStr}`;
}

/** Usa SCAN iterativo (seguro para produção) em vez de KEYS (bloqueante). */
async function scanKeys(redis, pattern) {
  const keys = [];
  let cursor = "0";

  do {
    const [nextCursor, found] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100
    );
    cursor = nextCursor;
    keys.push(...found);
  } while (cursor !== "0");

  return keys;
}

module.exports = { cache, invalidate };
