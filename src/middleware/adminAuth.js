/**
 * Middleware de autenticação para rotas /admin/*.
 *
 * Usa X-Admin-Key separado do X-API-Key das rotas de proxy,
 * para que o Ziva OS possa acessar o painel sem expor a chave de proxy.
 */

const adminAuth = (req, res, next) => {
  const key = req.headers["x-admin-key"];
  const validKey = process.env.GATEWAY_ADMIN_KEY;

  if (!validKey) {
    console.error("[ADMIN AUTH] GATEWAY_ADMIN_KEY não definida!");
    return res.status(500).json({ error: "GATEWAY_ADMIN_KEY não configurada" });
  }

  if (!key || key !== validKey) {
    return res.status(401).json({ error: "X-Admin-Key inválida ou ausente" });
  }

  next();
};

module.exports = adminAuth;
