// Registra o webhook no Banco Inter para uma ou mais chaves Pix.
// Uso (local ou como Render Job):
//   node register-webhook.js
//
// Variáveis de ambiente necessárias:
//   INTER_CLIENT_ID        - clientId da app com escopo webhook.write
//   INTER_CLIENT_SECRET    - clientSecret dessa mesma app
//   INTER_CERT_PATH        - caminho do cert.crt (mTLS)
//   INTER_KEY_PATH         - caminho do cert.key (mTLS)
//   WEBHOOK_URL            - URL pública que o Inter vai chamar
//   PIX_KEYS               - lista de chaves separadas por vírgula

const fs = require("fs");
const https = require("https");

const {
  INTER_CLIENT_ID,
  INTER_CLIENT_SECRET,
  INTER_CERT_PATH,
  INTER_KEY_PATH,
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
  console.error("❌ Variáveis faltando. Confira INTER_CLIENT_ID, INTER_CLIENT_SECRET, INTER_CERT_PATH, INTER_KEY_PATH, WEBHOOK_URL, PIX_KEYS.");
  process.exit(1);
}

const cert = fs.readFileSync(INTER_CERT_PATH);
const key = fs.readFileSync(INTER_KEY_PATH);
const agent = new https.Agent({ cert, key });

const BASE = "https://cdpj.partners.bancointer.com.br";

async function getToken() {
  const body = new URLSearchParams({
    client_id: INTER_CLIENT_ID,
    client_secret: INTER_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: "webhook.write webhook.read",
  }).toString();

  const res = await fetch(`${BASE}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    agent,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${text}`);
  return JSON.parse(text).access_token;
}

async function registerWebhook(token, chave) {
  const res = await fetch(`${BASE}/pix/v2/webhook/${encodeURIComponent(chave)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ webhookUrl: WEBHOOK_URL }),
    agent,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PUT ${chave} → ${res.status}: ${text}`);
  return text || "ok";
}

async function getWebhook(token, chave) {
  const res = await fetch(`${BASE}/pix/v2/webhook/${encodeURIComponent(chave)}`, {
    headers: { Authorization: `Bearer ${token}` },
    agent,
  });
  const text = await res.text();
  return `${res.status} ${text}`;
}

(async () => {
  console.log("🔑 Obtendo token OAuth...");
  const token = await getToken();
  console.log("✅ Token OK.");

  const chaves = PIX_KEYS.split(",").map((s) => s.trim()).filter(Boolean);
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
})();
