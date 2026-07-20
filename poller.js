// poller.js — consulta o extrato do Banco Inter e envia Pix recebidos pro painel.
// Execução: node poller.js  (rode a cada 30s ou como serviço permanente)

import fs from "node:fs";
import https from "node:https";
import fetch from "node-fetch";

const {
  INTER_CLIENT_ID,
  INTER_CLIENT_SECRET,
  INTER_CERT_PATH = "./cert.crt",
  INTER_KEY_PATH = "./cert.key",
  INGEST_URL,
  INGEST_TOKEN,
  POLL_INTERVAL_MS = "30000",
  LOOKBACK_DAYS = "2",
} = process.env;

const required = { INTER_CLIENT_ID, INTER_CLIENT_SECRET, INGEST_URL, INGEST_TOKEN };
for (const [k, v] of Object.entries(required)) {
  if (!v) {
    console.error(`❌ Falta variável de ambiente: ${k}`);
    process.exit(1);
  }
}

const agent = new https.Agent({
  cert: fs.readFileSync(INTER_CERT_PATH),
  key: fs.readFileSync(INTER_KEY_PATH),
});

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const body = new URLSearchParams({
    client_id: INTER_CLIENT_ID,
    client_secret: INTER_CLIENT_SECRET,
    scope: "extrato.read",
    grant_type: "client_credentials",
  }).toString();

  const res = await fetch("https://cdpj.partners.bancointer.com.br/oauth/v2/token", {
    method: "POST",
    agent,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`OAuth falhou: ${res.status} ${await res.text()}`);
  const json = await res.json();
  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
  console.log("🔑 Token OAuth obtido");
  return cachedToken;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchExtrato() {
  const token = await getToken();
  const hoje = new Date();
  const inicio = new Date(hoje);
  inicio.setDate(inicio.getDate() - Number(LOOKBACK_DAYS));

  const url = `https://cdpj.partners.bancointer.com.br/banking/v2/extrato?dataInicio=${fmtDate(inicio)}&dataFim=${fmtDate(hoje)}`;
  const res = await fetch(url, {
    agent,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Extrato falhou: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sendToPanel(transacoes) {
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({ transacoes }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ingest falhou: ${res.status} ${text}`);
  return JSON.parse(text);
}

async function tick() {
  try {
    const extrato = await fetchExtrato();
    const transacoes = extrato.transacoes ?? [];
    if (transacoes.length === 0) {
      console.log("· sem transações no período");
      return;
    }
    const result = await sendToPanel(transacoes);
    console.log(
      `✅ enviadas=${transacoes.length}  novas=${result.received}  duplicadas=${result.duplicated}  pix_credito=${result.total_pix}`,
    );
  } catch (err) {
    console.error("❌ erro no ciclo:", err.message);
  }
}

console.log(`🚀 Poller Inter iniciado — intervalo ${POLL_INTERVAL_MS}ms`);
tick();
setInterval(tick, Number(POLL_INTERVAL_MS));
