/**
 * Configuração centralizada das APIs suportadas pelo gateway.
 *
 * ─── Variáveis de ambiente (Railway) ─────────────────────────────────────────
 *  BLING_WINDOW_MS    — janela de tempo em ms        (padrão: 1000)
 *  BLING_MAX_REQUESTS — requisições por janela       (padrão: 2)
 */

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
    dailyLimit: 120000, // limite diário da API do Bling
    rateLimiter: {
      maxConcurrent: blingMaxRequests,
      minTime: blingMinTime,
      reservoir: blingMaxRequests,
      reservoirRefreshAmount: blingMaxRequests,
      reservoirRefreshInterval: blingWindowMs,
    },
    stripHeaders: ["host", "x-api-key", "x-forwarded-for"],
  },
};

module.exports = API_CONFIGS;
