// poller.js — consulta o extrato do Banco Inter e envia Pix recebidos pro painel.
// Execução: node poller.js  (rode a cada 15s ou como serviço permanente)

import fs from "node:fs";
import https from "node:https";
import fetch from "node-fetch";

const {
  INTER_CLIENT_ID,
  INTER_CLIENT_SECRET,
  INTER_CERT_PATH = "./cert.crt",
  INTER_KEY_PATH = "./cert.key",
  // Credenciais opcionais SÓ para o enriquecimento via /pix/v2/pix/{e2eid}.
  // Use um app do Inter que tenha o escopo "pix.read" (Consultar Pix recebidos).
  // Se não setar, cai nas credenciais principais.
  INTER_PIX_CLIENT_ID,
  INTER_PIX_CLIENT_SECRET,
  INTER_PIX_CERT_PATH,
  INTER_PIX_KEY_PATH,
  INGEST_URL,
  INGEST_TOKEN,
  POLL_INTERVAL_MS = "15000",
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

// Agent/credenciais para o app que tem escopo pix.read.
const pixClientId = INTER_PIX_CLIENT_ID || INTER_CLIENT_ID;
const pixClientSecret = INTER_PIX_CLIENT_SECRET || INTER_CLIENT_SECRET;
const pixAgent =
  INTER_PIX_CERT_PATH && INTER_PIX_KEY_PATH
    ? new https.Agent({
        cert: fs.readFileSync(INTER_PIX_CERT_PATH),
        key: fs.readFileSync(INTER_PIX_KEY_PATH),
      })
    : agent;
const pixIsSeparate =
  pixClientId !== INTER_CLIENT_ID || pixClientSecret !== INTER_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiresAt = 0;
let cachedPixToken = null;
let pixTokenExpiresAt = 0;

async function fetchToken(clientId, clientSecret, scope, useAgent) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope,
    grant_type: "client_credentials",
  }).toString();
  const res = await fetch("https://cdpj.partners.bancointer.com.br/oauth/v2/token", {
    method: "POST",
    agent: useAgent,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`OAuth falhou: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const json = await fetchToken(
    INTER_CLIENT_ID,
    INTER_CLIENT_SECRET,
    "extrato.read",
    agent,
  );
  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
  console.log("🔑 Token OAuth (extrato) obtido");
  return cachedToken;
}

async function getPixToken() {
  if (cachedPixToken && Date.now() < pixTokenExpiresAt - 60_000) return cachedPixToken;
  const json = await fetchToken(pixClientId, pixClientSecret, "pix.read", pixAgent);
  cachedPixToken = json.access_token;
  pixTokenExpiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
  console.log("🔑 Token OAuth (pix.read) obtido");
  return cachedPixToken;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchExtrato() {
  const token = await getToken();
  const hoje = new Date();
  const inicio = new Date(hoje);
  inicio.setDate(inicio.getDate() - Number(LOOKBACK_DAYS));

  const pageSize = 100;
  const transacoes = [];
  let pagina = 0;
  for (; pagina < 20; pagina++) {
    const url =
      `https://cdpj.partners.bancointer.com.br/banking/v2/extrato/completo` +
      `?dataInicio=${fmtDate(inicio)}&dataFim=${fmtDate(hoje)}` +
      `&pagina=${pagina}&tamanhoPagina=${pageSize}`;

    const res = await fetch(url, {
      agent,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Extrato falhou: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const lote = json.transacoes ?? [];
    for (const t of lote) {
      const d = t.detalhes ?? {};
      transacoes.push({
        ...d,
        ...t,
        endToEndId: d.endToEndId ?? d.endToEnd ?? t.endToEndId ?? undefined,
        idTransacao: d.idTransacao ?? t.idTransacao ?? undefined,
        pagador: d.nomePagador ?? d.pagador ?? d.nomeRecebedor ?? undefined,
        cpfCnpjPagador: d.cpfCnpjPagador ?? d.cpfCnpjRecebedor ?? undefined,
        chavePix:
          d.chavePix ??
          d.chave ??
          d.chaveRecebedor ??
          d.chavePagador ??
          t.chavePix ??
          undefined,
        descricao: t.descricao || d.descricao || d.descricaoOperacao || undefined,
      });
    }
    if (lote.length < pageSize) break;
  }

  // Enriquecimento: quando a chavePix vier vazia no extrato (comum quando o
  // pagador é de outro banco, ex: BB endToEndId E00000000...), consulta o
  // endpoint oficial de PIX pelo endToEndId para recuperar a chave do
  // recebedor. Usa credenciais com escopo pix.read (INTER_PIX_*).
  let pixToken;
  try {
    pixToken = await getPixToken();
  } catch (e) {
    console.warn(`⚠️  não foi possível obter token pix.read: ${e.message}`);
  }

  const faltantes = pixToken
    ? transacoes.filter(
        (t) => !t.chavePix && t.endToEndId && /^E\d{8}/.test(String(t.endToEndId)),
      )
    : [];
  if (faltantes.length > 0) {
    console.log(`🔎 buscando detalhe PIX para ${faltantes.length} transação(ões) sem chave`);
  }
  for (const t of faltantes) {
    try {
      const det = await fetchPixDetailWithRetry(t.endToEndId, pixToken);
      if (!det) continue;
      const chave = findRecebedorKey(det);
      if (chave) {
        t.chavePix = chave;
        console.log(`✔ chave recuperada para ${t.endToEndId}: ${chave}`);
      }
      const pag = det.pagador ?? {};
      if (!t.pagador) t.pagador = pag.nome ?? det.nomePagador ?? undefined;
      if (!t.cpfCnpjPagador) t.cpfCnpjPagador = pag.cpfCnpj ?? pag.cnpj ?? pag.cpf ?? undefined;
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      console.warn(`· erro ao consultar detalhe ${t.endToEndId}: ${e.message}`);
    }
  }

  return transacoes;
}

async function fetchPixDetailWithRetry(endToEndId, pixToken) {
  const attempts = Number(process.env.PIX_DETAIL_RETRIES || "4");
  const retryDelay = Number(process.env.PIX_DETAIL_RETRY_DELAY_MS || "2500");
  const url = `https://cdpj.partners.bancointer.com.br/pix/v2/pix/${encodeURIComponent(endToEndId)}`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(url, {
      agent: pixAgent,
      headers: { Authorization: `Bearer ${pixToken}` },
    });

    if (res.ok) return res.json();

    const txt = await res.text();
    console.warn(
      `· detalhe PIX ${endToEndId} falhou: ${res.status} ${txt.slice(0, 200)}${
        attempt < attempts ? ` — tentativa ${attempt}/${attempts}` : ""
      }`,
    );

    if (![404, 429, 500, 502, 503, 504].includes(res.status) || attempt === attempts) {
      return null;
    }
    await new Promise((r) => setTimeout(r, retryDelay));
  }
  return null;
}

function findRecebedorKey(detail) {
  const candidates = [
    detail?.chave,
    detail?.chavePix,
    detail?.chaveRecebedor,
    detail?.chavePixRecebedor,
    detail?.recebedor?.chave,
    detail?.recebedor?.chavePix,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
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
    const transacoes = await fetchExtrato();
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
