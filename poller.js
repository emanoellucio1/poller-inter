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
  const maxPages = Number(process.env.MAX_PAGES || "5");
  const transacoes = [];
  let pagina = 0;
  for (; pagina < maxPages; pagina++) {
    const url =
      `https://cdpj.partners.bancointer.com.br/banking/v2/extrato/completo` +
      `?dataInicio=${fmtDate(inicio)}&dataFim=${fmtDate(hoje)}` +
      `&pagina=${pagina}&tamanhoPagina=${pageSize}`;

    const res = await fetchWithBackoff(url, { agent, headers: { Authorization: `Bearer ${token}` } });
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
        dataHoraMovimento: t.dataHoraMovimento ?? d.dataHoraMovimento ?? t.dataInclusao ?? undefined,
      });
    }
    if (lote.length < pageSize) break;
  }

  // Enriquecimento: SÓ para transações recentes e com endToEndId válido do
  // BACEN. IDs "sintéticos" do Inter (com letras minúsculas) nunca existem
  // na API oficial do PIX — pular direto.
  let pixToken;
  try {
    pixToken = await getPixToken();
  } catch (e) {
    console.warn(`⚠️  não foi possível obter token pix.read: ${e.message}`);
  }

  const enrichWindowMin = Number(process.env.ENRICH_WINDOW_MIN || "30");
  const maxEnrich = Number(process.env.MAX_ENRICH_PER_CYCLE || "20");
  const cutoff = Date.now() - enrichWindowMin * 60_000;
  // E2E BACEN válido: E + 8 dígitos ISPB + 12 dígitos data + 11 alfanuméricos MAIÚSCULOS
  const validE2E = /^E\d{8}\d{12}[A-Z0-9]{11}$/;

  const faltantes = pixToken
    ? transacoes
        .filter((t) => {
          if (t.chavePix) return false;
          if (!t.endToEndId || !validE2E.test(String(t.endToEndId))) return false;
          const ts = t.dataHoraMovimento ? Date.parse(t.dataHoraMovimento) : NaN;
          return isNaN(ts) ? true : ts >= cutoff;
        })
        .slice(0, maxEnrich)
    : [];
  if (faltantes.length > 0) {
    console.log(`🔎 buscando detalhe PIX para ${faltantes.length} transação(ões) sem chave (janela ${enrichWindowMin}min)`);
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
      await new Promise((r) => setTimeout(r, 200));
    } catch (e) {
      console.warn(`· erro ao consultar detalhe ${t.endToEndId}: ${e.message}`);
    }
  }

  return transacoes;
}

async function fetchWithBackoff(url, options, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt === maxAttempts) return res;
    const wait = 2000 * attempt;
    console.warn(`⏳ 429 rate limit — aguardando ${wait}ms (tentativa ${attempt}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return fetch(url, options);
}

async function fetchPixDetailWithRetry(endToEndId, pixToken) {
  const attempts = Number(process.env.PIX_DETAIL_RETRIES || "2");
  const retryDelay = Number(process.env.PIX_DETAIL_RETRY_DELAY_MS || "3000");
  const url = `https://cdpj.partners.bancointer.com.br/pix/v2/pix/${encodeURIComponent(endToEndId)}`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(url, {
      agent: pixAgent,
      headers: { Authorization: `Bearer ${pixToken}` },
    });

    if (res.ok) return res.json();

    const txt = await res.text();
    // 404 do BCB é permanente: transação não indexada. Não retenta.
    if (res.status === 404) {
      console.warn(`· detalhe PIX ${endToEndId} não indexado (404) — pulando`);
      return null;
    }
    console.warn(
      `· detalhe PIX ${endToEndId} falhou: ${res.status} ${txt.slice(0, 200)}${
        attempt < attempts ? ` — tentativa ${attempt}/${attempts}` : ""
      }`,
    );

    if (![429, 500, 502, 503, 504].includes(res.status) || attempt === attempts) {
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
