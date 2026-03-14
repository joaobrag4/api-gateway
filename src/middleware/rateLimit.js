/**
 * Middleware de Rate Limiting distribuído via Redis.
 *
 * Usa o Bottleneck com adapter IORedis, que armazena os contadores de
 * requisições no Redis em vez de memória local. Isso garante que o limite
 * seja respeitado globalmente, independente de quantas instâncias do
 * gateway estejam rodando (escalabilidade horizontal no Railway).
 *
 * Modo degradado: se Redis não estiver disponível, o limiter opera em
 * memória local — funcional, mas sem compartilhamento entre instâncias.
 */

const Bottleneck = require("bottleneck");
const { getClient, getSubscriber } = require("../redis");

// Cache de limiters já criados (um por API)
const limiters = new Map();

/**
 * Retorna (criando se necessário) um Bottleneck rate limiter para a API especificada.
 *
 * @param {string} apiName  - Identificador da API (ex: "bling"). Usado como prefixo no Redis.
 * @param {object} config   - Configuração do Bottleneck (maxConcurrent, minTime, reservoir, etc.)
 * @returns {Bottleneck}    - Instância do rate limiter
 */
function getLimiter(apiName, config) {
  if (limiters.has(apiName)) return limiters.get(apiName);

  const redisClient = getClient();
  const redisSubscriber = getSubscriber();

  let limiter;

  if (redisClient && redisSubscriber) {
    // ── Modo Redis (distribuído) ──────────────────────────────────────────────
    // O Bottleneck armazena o estado no Redis com a chave `gateway:ratelimit:<apiName>`.
    // clearDatastore: false → preserva o estado entre restarts do container.
    try {
      const { IORedisConnection } = require("bottleneck/es5");

      limiter = new Bottleneck({
        ...config,
        id: `gateway:ratelimit:${apiName}`,
        datastore: "ioredis",
        clearDatastore: false,
        connection: new IORedisConnection({
          client: redisClient,
          subscriber: redisSubscriber,
        }),
      });

      console.log(
        `[RATE LIMIT] ✅ "${apiName}" usando Redis (modo distribuído)`
      );
    } catch (err) {
      // Fallback para memória se algo der errado na inicialização do adapter
      console.error(
        `[RATE LIMIT] ❌ Falha ao inicializar adapter Redis para "${apiName}":`,
        err.message
      );
      limiter = new Bottleneck(config);
      console.warn(
        `[RATE LIMIT] ⚠️  "${apiName}" usando memória local (fallback)`
      );
    }
  } else {
    // ── Modo memória (degradado) ──────────────────────────────────────────────
    limiter = new Bottleneck(config);
    console.warn(
      `[RATE LIMIT] ⚠️  "${apiName}" usando memória local (Redis indisponível)`
    );
  }

  limiter.on("queued", (info) =>
    console.log(
      `[${apiName.toUpperCase()}] Requisição enfileirada | Na fila: ${info.size}`
    )
  );

  limiter.on("error", (err) =>
    console.error(
      `[${apiName.toUpperCase()}] Erro no rate limiter: ${err.message}`
    )
  );

  limiters.set(apiName, limiter);
  return limiter;
}

module.exports = { getLimiter };
