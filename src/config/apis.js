/**
 * Configuração centralizada das APIs suportadas pelo gateway.
 *
 * ─── Variáveis de ambiente (Railway) ─────────────────────────────────────────
 *  BLING_CLIENT_ID    — client_id do app OAuth2 Bling
 *  BLING_CLIENT_SECRET— client_secret do app OAuth2 Bling
 *  BLING_REFRESH_TOKEN— refresh_token inicial (obtido na primeira autorização)
 *  BLING_API_TOKEN    — token estático (fallback; usado se OAuth2 não estiver configurado)
 *  BLING_WINDOW_MS    — janela de tempo em ms        (padrão: 1000)
 *  BLING_MAX_REQUESTS — requisições por janela       (padrão: 2)
 *  ME_CLIENT_ID       — Client ID OAuth2 Melhor Envio
 *  ME_CLIENT_SECRET   — Client Secret OAuth2 Melhor Envio
 *  MR_USERNAME        — email da conta Melhor Rastreio (Keycloak)
 *  MR_PASSWORD        — senha da conta Melhor Rastreio
 *  MR_ACCESS_TOKEN    — token estático (fallback sem renovação automática)
 */

const blingWindowMs    = parseInt(process.env.BLING_WINDOW_MS    || "1000", 10);
const blingMaxRequests = parseInt(process.env.BLING_MAX_REQUESTS || "2",    10);
const blingMinTime     = Math.ceil(blingWindowMs / blingMaxRequests);

// Melhor Envio: 250 req/min → ~4 req/s
const meWindowMs    = 60_000;
const meMaxRequests = 250;
const meMinTime     = Math.ceil(meWindowMs / meMaxRequests);

// Melhor Rastreio: limite não documentado; 60 req/min conservador
const mrWindowMs    = 60_000;
const mrMaxRequests = 60;
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
    stripHeaders: ["host", "x-api-key", "x-forwarded-for", "authorization"],
    // authorization é stripped porque o gateway injeta o Bearer token OAuth2 automaticamente
  },

  melhorenvio: {
    name: "Melhor Envio",
    baseUrl: "https://melhorenvio.com.br",
    dailyLimit: null, // sem limite diário documentado
    rateLimiter: {
      maxConcurrent: meMaxRequests,
      minTime: meMinTime,
      reservoir: meMaxRequests,
      reservoirRefreshAmount: meMaxRequests,
      reservoirRefreshInterval: meWindowMs,
    },
    stripHeaders: ["host", "x-api-key", "x-forwarded-for", "authorization"],
    // authorization é stripped porque o gateway injeta o Bearer token do OAuth2 automaticamente
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
    stripHeaders: ["host", "x-api-key", "x-forwarded-for", "authorization"],
    // authorization é stripped porque o gateway injeta o Keycloak JWT automaticamente
  },
};

module.exports = API_CONFIGS;
