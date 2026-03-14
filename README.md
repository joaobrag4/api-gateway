# API Gateway

Gateway de proxy com rate limiting para APIs externas. Criado para evitar erros de limite de requisições em sistemas de automação (n8n).

## APIs Suportadas

| API | Rota | Limite |
|-----|------|--------|
| Bling ERP | `/bling/*` | 3 req/s |

## Segurança

Todas as rotas (exceto `/health`) exigem o header:
```
X-API-Key: <valor do GATEWAY_API_KEY>
```

Sem esse header, a requisição é rejeitada com `401 Unauthorized`.

## Como Usar (no n8n)

Substitua a URL base das requisições ao Bling:

**Antes:**
```
https://api.bling.com.br/Api/v3/pedidos/vendas/123
```

**Depois:**
```
https://seu-gateway.railway.app/bling/Api/v3/pedidos/vendas/123
```

Adicione o header em cada node HTTP Request:
```
X-API-Key: <sua chave>
```

Todos os outros headers (Authorization, Cookie, etc.) são repassados automaticamente ao Bling.

## Deploy no Railway

1. Conecte o repositório GitHub ao Railway
2. Defina as variáveis de ambiente:
   - `GATEWAY_API_KEY` → uma string secreta forte (ex: `openssl rand -hex 32`)
3. O Railway detecta automaticamente o `npm start`

## Desenvolvimento Local

```bash
# 1. Instalar dependências
npm install

# 2. Criar arquivo .env
cp .env.example .env
# Edite o .env e defina GATEWAY_API_KEY

# 3. Iniciar em modo desenvolvimento
npm run dev
```

## Endpoints

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| GET | `/health` | ❌ | Status do gateway |
| ANY | `/bling/*` | ✅ | Proxy para o Bling |

## Adicionar Nova API (ex: Melhor Envio)

1. Adicione a configuração em `src/config/apis.js`
2. Crie `src/proxies/melhorenvio.js` (copie o modelo do bling.js)
3. Registre a rota em `src/index.js`:
   ```js
   app.use("/melhorenvio", auth, melhorEnvioProxy);
   ```
