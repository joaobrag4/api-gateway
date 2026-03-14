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
 * - minTime: intervalo mínimo em ms entre requisições (ex: 334ms = ~3 req/s)
 * - reservoir: "créditos" disponíveis no período
 * - reservoirRefreshAmount: créditos reposto a cada refresh
 * - reservoirRefreshInterval: intervalo do refresh em ms
 */

const API_CONFIGS = {
  bling: {
    name: "Bling ERP",
    baseUrl: "https://api.bling.com.br",
    // 3 requisições por segundo conforme documentação do Bling
    rateLimiter: {
      maxConcurrent: 3,
      minTime: 334, // ~3 req/s (1000ms / 3 = 333.33ms)
      reservoir: 3,
      reservoirRefreshAmount: 3,
      reservoirRefreshInterval: 1000, // 1 segundo
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
