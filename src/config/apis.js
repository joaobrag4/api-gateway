/**
 * Configuração centralizada das APIs suportadas pelo gateway.
 *
 * O gateway é um proxy de rate limiting — não gerencia tokens.
 * O Ziva OS envia o header Authorization com o token correto em cada request.
 *
 * ─── Variáveis de ambiente (Railway) ─────────────────────────────────────────
 *  BLING_WINDOW_MS    — janela de tempo em ms        (padrão: 1000)
 *  BLING_MAX_REQUESTS — requisições por janela       (padrão: 2)
 */

const blingWindowMs    = parseInt(process.env.BLING_WINDOW_MS    || "1000", 10);
const blingMaxRequests = parseInt(process.env.BLING_MAX_REQUESTS || "2",    10);
const blingMinTime     = Math.ceil(blingWindowMs / blingMaxRequests);

// Melhor Envio: 250 req/min → ~4 req/s
const meWindowMs    = 60_000;
const meMaxRequests = 250;
const meMinTime     = Math.ceil(meWindowMs / meMaxRequests);

// Melhor Rastreio: ~100 req/s testado em produção — 300 req/min conservador
const mrWindowMs    = 60_000;
const mrMaxRequests = 300;
const mrMinTime     = Math.ceil(mrWindowMs / mrMaxRequests);

console.log(
  `[CONFIG] Bling rate limit: ${blingMaxRequests} req / ${blingWindowMs}ms` +
  ` → minTime: ${blingMinTime}ms`
);
console.log(
  `[CONFIG] Melhor Envio rate limit: ${meMaxRequests} req / ${meWindowMs}ms` +
  ` → minTime: ${meMinTime}ms`
);
console.log(
  `[CONFIG] Melhor Rastreio rate limit: ${mrMaxRequests} req / ${mrWindowMs}ms` +
  ` → minTime: ${mrMinTime}ms`
);

const API_CONFIGS = {
  bling: {
    name: "Bling ERP",
    baseUrl: "https://api.bling.com.br",
    dailyLimit: 120000,
    rateLimiter: {
      maxConcurrent: blingMaxRequests,
      minTime: blingMinTime,
      reservoir: blingMaxRequests,
      reservoirRefreshAmount: blingMaxRequests,
      reservoirRefreshInterval: blingWindowMs,
    },
    // Não stripa authorization — o Ziva OS envia o token
    stripHeaders: ["host", "x-api-key", "x-forwarded-for"],
  },

  melhorenvio: {
    name: "Melhor Envio",
    baseUrl: "https://melhorenvio.com.br",
    dailyLimit: null,
    rateLimiter: {
      maxConcurrent: meMaxRequests,
      minTime: meMinTime,
      reservoir: meMaxRequests,
      reservoirRefreshAmount: meMaxRequests,
      reservoirRefreshInterval: meWindowMs,
    },
    // Não stripa authorization — o Ziva OS envia o token
    stripHeaders: ["host", "x-api-key", "x-forwarded-for"],
  },

  melhorrastreio: {
    name: "Melhor Rastreio",
    baseUrl: "https://melhor-rastreio-api.melhorrastreio.com.br",
    dailyLimit: null,
    rateLimiter: {
      maxConcurrent: mrMaxRequests,
      minTime: mrMinTime,
      reservoir: mrMaxRequests,
      reservoirRefreshAmount: mrMaxRequests,
      reservoirRefreshInterval: mrWindowMs,
    },
    // Não stripa authorization — o Ziva OS envia o token
    stripHeaders: ["host", "x-api-key", "x-forwarded-for"],
  },
};

module.exports = API_CONFIGS;
