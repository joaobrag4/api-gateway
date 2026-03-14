/**
 * Middleware de autenticação via API Key.
 *
 * Todas as requisições devem incluir o header:
 *   X-API-Key: <valor do GATEWAY_API_KEY no .env>
 *
 * Sem esse header (ou com chave errada), a requisição é rejeitada
 * com 401 — o serviço fica invisível para quem não tem a chave.
 */

const auth = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  const validKey = process.env.GATEWAY_API_KEY;

  if (!validKey) {
    console.error(
      "[AUTH] GATEWAY_API_KEY não definida nas variáveis de ambiente!"
    );
    return res.status(500).json({
      error: "Configuração inválida do servidor",
      message: "GATEWAY_API_KEY não configurada",
    });
  }

  if (!apiKey) {
    return res.status(401).json({
      error: "Não autorizado",
      message: "Header X-API-Key obrigatório",
    });
  }

  if (apiKey !== validKey) {
    console.warn(
      `[AUTH] Tentativa com chave inválida. IP: ${req.ip} | Path: ${req.path}`
    );
    return res.status(401).json({
      error: "Não autorizado",
      message: "API Key inválida",
    });
  }

  next();
};

module.exports = auth;
