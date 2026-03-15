/**
 * Configuração centralizada das APIs suportadas pelo gateway.
 *
 * Para adicionar uma nova API:
 * 1. Adicione uma entrada neste objeto
 * 2. Crie o arquivo de proxy em src/proxies/<nome>.js
 * 3. Registre a rota em src/index.js
 *
 * Parâmetros do Bottleneck (rate limiter):
 * - maxConcurrent: requisições simultâneas máximas
 * - minTime: intervalo mínimo em ms entre requisições (ex: 500ms = 2 req/s)
 * - reservoir: "créditos" disponíveis no período
 * - reservoirRefreshAmount: créditos repostos a cada refresh
 * - reservoirRefreshInterval: intervalo do refresh em ms
 *
 * ─── Variáveis de ambiente (Railway) ─────────────────────────────────────────
 *
 *  BLING_WINDOW_MS    — janela de tempo em ms        (padrão: 1000 = 1 segundo)
 *  BLING_MAX_REQUESTS — requisições por janela       (padrão: 2)
 *
 *  Exemplo:
 *    BLING_WINDOW_MS=1000  →  1 segundo
 *    BLING_MAX_REQUESTS=2  →  2 req/s  →  minTime = 500ms
 *    BLING_MAX_REQUESTS=3  →  3 req/s  →  minTime = 334ms
 */

// ─── Bling rate limit via env vars ───────────────────────────────────────────
const blingWindowMs    = parseInt(process.env.BLING_WINDOW_MS    || "1000", 10);
const blingMaxRequests = parseInt(process.env.BLING_MAX_REQUESTS || "2",    10);
const blingMinTime     = Math.ceil(blingWindowMs / blingMaxRequests);

console.log(
  `[CONFIG] Bling rate limit: ${blingMaxRequests} req / ${blingWindowMs}ms` +
  ` → minTime: ${blingMinTime}ms`
);

const API_CONFIGS = {
  bling: {
    name: "Bling ERP",
    baseUrl: "https://api.bling.com.br",
    rateLimiter: {
      maxConcurrent: blingMaxRequests,
      minTime: blingMinTime,
      reservoir: blingMaxRequests,
      reservoirRefreshAmount: blingMaxRequests,
      reservoirRefreshInterval: blingWindowMs,
    },
    // Headers que NÃO devem ser repassados ao destino
    stripHeaders: ["host", "x-api-key", "x-forwarded-for"],
  },

  // Melhor Envio — descomentar e expandir quando necessário
  // melhorenvio: {
  //   name: "Melhor Envio",
  //   baseUrl: "https://melhorenvio.com.br",
  //   rateLimiter: {
  //     maxConcurrent: 5,
  //     minTime: 200, // 5 req/s
  //     reservoir: 5,
  //     reservoirRefreshAmount: 5,
  //     reservoirRefreshInterval: 1000,
  //   },
  //   stripHeaders: ["host", "x-api-key"],
  // },
};

module.exports = API_CONFIGS;
