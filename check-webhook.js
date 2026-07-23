// Diagnóstico: lista o webhook registrado no Banco Inter para cada chave PIX.
// Uso no Render Shell (mesma app que registrou os webhooks — precisa scope webhook.read):
//   cd /opt/render/project
//   export INTER_CLIENT_ID=...
//   export INTER_CLIENT_SECRET=...
//   export INTER_CERT_PATH=/etc/secrets/cert.crt
//   export INTER_KEY_PATH=/etc/secrets/cert.key
//   export PIX_KEYS="33548259000201,823edc7c-7250-46ab-bae2-3484284b2be0,ff5bb840-b067-4099-9581-0fc749c216e7"
//   node src/check-webhook.js
//
// Também lista as últimas tentativas de callback (GET /webhook/{chave}/callbacks) das últimas 24h,
// úteis para saber se o Inter está tentando entregar e falhando.

import fs from "node:fs";
import https from "node:https";

const {
  INTER_CLIENT_ID,
  INTER_CLIENT_SECRET,
  INTER_CERT_PATH = "./cert.crt",
  INTER_KEY_PATH = "./cert.key",
  PIX_KEYS,
} = process.env;

if (!INTER_CLIENT_ID || !INTER_CLIENT_SECRET || !PIX_KEYS) {
  console.error(
    "❌ Variáveis faltando. Confira INTER_CLIENT_ID, INTER_CLIENT_SECRET, INTER_CERT_PATH, INTER_KEY_PATH, PIX_KEYS.",
  );
  process.exit(1);
}

const cert = fs.readFileSync(INTER_CERT_PATH);
const key = fs.readFileSync(INTER_KEY_PATH);
const agent = new https.Agent({ cert, key });

const BASE = "https://cdpj.partners.bancointer.com.br";

function request(path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(`${BASE}${path}`, { method, headers, agent }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  const body = new URLSearchParams({
    client_id: INTER_CLIENT_ID,
    client_secret: INTER_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: "webhook.read pix.read",
  }).toString();
  const res = await request(
    "/oauth/v2/token",
    "POST",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  );
  if (res.status !== 200) throw new Error(`OAuth ${res.status}: ${res.body}`);
  return JSON.parse(res.body).access_token;
}

async function getWebhook(token, chave) {
  return request(
    `/pix/v2/webhook/${encodeURIComponent(chave)}`,
    "GET",
    { Authorization: `Bearer ${token}` },
    null,
  );
}

async function getCallbacks(token, chave) {
  // últimas 24h
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  const qs = new URLSearchParams({
    dataHoraInicio: from.toISOString(),
    dataHoraFim: to.toISOString(),
  }).toString();
  return request(
    `/pix/v2/webhook/${encodeURIComponent(chave)}/callbacks?${qs}`,
    "GET",
    { Authorization: `Bearer ${token}` },
    null,
  );
}

const chaves = PIX_KEYS.split(",").map((s) => s.trim()).filter(Boolean);

console.log("🔑 Obtendo token OAuth (webhook.read + pix.read)…");
try {
  const token = await getToken();
  console.log("✅ Token OK.\n");

  for (const chave of chaves) {
    console.log(`━━━ Chave: ${chave} ━━━`);
    try {
      const wh = await getWebhook(token, chave);
      console.log(`GET /webhook → ${wh.status}`);
      console.log(wh.body || "(vazio)");
    } catch (e) {
      console.error("❌ webhook:", e.message);
    }
    try {
      const cb = await getCallbacks(token, chave);
      console.log(`\nGET /callbacks (últimas 24h) → ${cb.status}`);
      // tenta pretty-print
      try {
        const j = JSON.parse(cb.body);
        console.log(JSON.stringify(j, null, 2).slice(0, 4000));
      } catch {
        console.log(cb.body.slice(0, 2000));
      }
    } catch (e) {
      console.error("❌ callbacks:", e.message);
    }
    console.log("");
  }
} catch (err) {
  console.error("❌ Falha geral:", err.message);
  process.exit(1);
}
