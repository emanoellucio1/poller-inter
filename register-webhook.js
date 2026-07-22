// Registra o webhook no Banco Inter para uma ou mais chaves Pix.
// Uso no Render Shell (ou local):
//   cd /opt/render/project
//   export INTER_CLIENT_ID=...
//   export INTER_CLIENT_SECRET=...
//   export INTER_CERT_PATH=/etc/secrets/cert.crt
//   export INTER_KEY_PATH=/etc/secrets/cert.key
//   export WEBHOOK_URL=https://pixel-perfect-clone-53016.lovable.app/api/public/webhook-pix-inter
//   export PIX_KEYS="33548259000201,823edc7c-7250-46ab-bae2-3484284b2be0,ff5bb840-b067-4099-9581-0fc749c216e7"
//   node src/register-webhook.js

import fs from "node:fs";
import https from "node:https";

const {
  INTER_CLIENT_ID,
  INTER_CLIENT_SECRET,
  INTER_CERT_PATH = "./cert.crt",
  INTER_KEY_PATH = "./cert.key",
  WEBHOOK_URL,
  PIX_KEYS,
} = process.env;

if (
  !INTER_CLIENT_ID ||
  !INTER_CLIENT_SECRET ||
  !INTER_CERT_PATH ||
  !INTER_KEY_PATH ||
  !WEBHOOK_URL ||
  !PIX_KEYS
) {
  console.error(
    "❌ Variáveis faltando. Confira INTER_CLIENT_ID, INTER_CLIENT_SECRET, INTER_CERT_PATH, INTER_KEY_PATH, WEBHOOK_URL, PIX_KEYS.",
  );
  process.exit(1);
}

const cert = fs.readFileSync(INTER_CERT_PATH);
const key = fs.readFileSync(INTER_KEY_PATH);
const agent = new https.Agent({ cert, key });

const BASE = "https://cdpj.partners.bancointer.com.br";

function request(path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${BASE}${path}`,
      { method, headers, agent },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
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
    scope: "webhook.write webhook.read",
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

async function registerWebhook(token, chave) {
  const body = JSON.stringify({ webhookUrl: WEBHOOK_URL });
  const res = await request(
    `/pix/v2/webhook/${encodeURIComponent(chave)}`,
    "PUT",
    {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  );
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    throw new Error(`PUT ${chave} → ${res.status}: ${res.body}`);
  }
  return res.body || "ok";
}

async function getWebhook(token, chave) {
  const res = await request(
    `/pix/v2/webhook/${encodeURIComponent(chave)}`,
    "GET",
    { Authorization: `Bearer ${token}` },
    null,
  );
  return `${res.status} ${res.body}`;
}

const chaves = PIX_KEYS.split(",").map((s) => s.trim()).filter(Boolean);

console.log("🔑 Obtendo token OAuth...");
try {
  const token = await getToken();
  console.log("✅ Token OK.");

  for (const chave of chaves) {
    try {
      console.log(`\n➡️  Registrando webhook para: ${chave}`);
      await registerWebhook(token, chave);
      console.log(`✅ Registrado.`);
      const info = await getWebhook(token, chave);
      console.log(`ℹ️  Consulta: ${info}`);
    } catch (err) {
      console.error(`❌ Falhou para ${chave}:`, err.message);
    }
  }
} catch (err) {
  console.error("❌ Falha geral:", err.message);
  process.exit(1);
}
