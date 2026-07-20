# Poller Inter → Painel

Consulta o extrato do Banco Inter via mTLS e envia os Pix recebidos pro painel.

## Deploy no Render.com (grátis)

1. Crie conta em https://render.com
2. **New → Background Worker** (não é Web Service)
3. Conecte um repositório Git com estes 4 arquivos, OU use "Deploy from public Git repo"
4. Configure:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node poller.js`
5. Em **Environment → Secret Files**, adicione:
   - `cert.crt` — cole o conteúdo de `Inter API_Certificado.crt`
   - `cert.key` — cole o conteúdo de `Inter API_Chave.key`
6. Em **Environment → Environment Variables**:
   - `INTER_CLIENT_ID` = seu clientId
   - `INTER_CLIENT_SECRET` = seu clientSecret
   - `INTER_CERT_PATH` = `/etc/secrets/cert.crt`
   - `INTER_KEY_PATH` = `/etc/secrets/cert.key`
   - `INGEST_URL` = `https://pixel-perfect-clone-53016.lovable.app/api/public/ingest-extrato-inter`
   - `INGEST_TOKEN` = (pergunte ao Lovable pra revelar o valor de `INGEST_TOKEN`)
   - `POLL_INTERVAL_MS` = `30000` (30 segundos)
   - `LOOKBACK_DAYS` = `2`
7. Deploy. Nos logs deve aparecer `🚀 Poller Inter iniciado`.

## Rodar local (teste)

```bash
cd poller-inter
npm install
export INTER_CLIENT_ID=...
export INTER_CLIENT_SECRET=...
export INTER_CERT_PATH="../Inter API_Certificado.crt"
export INTER_KEY_PATH="../Inter API_Chave.key"
export INGEST_URL="https://pixel-perfect-clone-53016.lovable.app/api/public/ingest-extrato-inter"
export INGEST_TOKEN=...
node poller.js
```
