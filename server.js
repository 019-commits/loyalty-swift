const express = require('express');
const path = require('path');
const { getLatestImagePost, cleanChannel } = require('./telegram');
const { recognizeRates } = require('./ocr');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const CHANNEL = cleanChannel(process.env.TELEGRAM_CHANNEL || 'LoyaltySwift');
const CACHE_MS = Math.max(60_000, Number(process.env.UPDATE_INTERVAL_MS || 5 * 60_000));
const REQUEST_TIMEOUT_MS = Math.max(30_000, Number(process.env.REQUEST_TIMEOUT_MS || 45_000));

let state = {
  success: false,
  channel: CHANNEL,
  rates: {},
  updatedAt: null,
  sourcePostId: null,
  sourcePostDate: null,
  imageUrl: null,
  postUrl: null,
  feedUrl: null,
  rawText: '',
  regions: {},
  errors: [],
  error: null
};

let lastAttemptAt = 0;
let updatePromise = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'loyalty-swift-rates',
    channel: CHANNEL,
    hasRates: state.success,
    updatedAt: state.updatedAt,
    error: state.error
  });
});

app.get('/api/rates', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (isStale()) {
    try { await updateRates(false); } catch (_) { /* keep last good state */ }
  }
  res.json(publicState());
});

app.post('/api/update', async (_req, res) => {
  try {
    const result = await updateRates(true);
    res.json(result);
  } catch (error) {
    res.status(502).json({ success: false, ...publicState(), error: error.message });
  }
});

app.get('/api/debug', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...publicState(), rawText: state.rawText, regions: state.regions, errors: state.errors });
});

function isStale() {
  return !state.updatedAt || Date.now() - lastAttemptAt >= CACHE_MS;
}

function publicState() {
  return {
    success: state.success,
    channel: state.channel,
    rates: state.rates,
    updatedAt: state.updatedAt,
    sourcePostId: state.sourcePostId,
    sourcePostDate: state.sourcePostDate,
    imageUrl: state.imageUrl,
    postUrl: state.postUrl,
    feedUrl: state.feedUrl,
    error: state.error
  };
}

async function updateRates(force) {
  if (updatePromise) return updatePromise;
  if (!force && !isStale()) return publicState();

  lastAttemptAt = Date.now();
  updatePromise = (async () => {
    console.log(`Updating @${CHANNEL} from public Telegram web preview...`);
    const source = await getLatestImagePost(CHANNEL);
    const recognized = await withTimeout(recognizeRates(source.buffer), REQUEST_TIMEOUT_MS, `OCR timeout after ${REQUEST_TIMEOUT_MS} ms`);

    const next = {
      success: true,
      channel: CHANNEL,
      rates: recognized.rates,
      updatedAt: new Date().toISOString(),
      sourcePostId: source.id,
      sourcePostDate: source.date,
      imageUrl: source.imageUrl,
      postUrl: source.postUrl,
      feedUrl: source.feedUrl,
      rawText: recognized.rawText,
      regions: recognized.regions,
      errors: recognized.errors,
      error: null
    };

    state = next;
    console.log(`Rates updated from post ${source.id}:`, recognized.rates);
    return publicState();
  })().catch(error => {
    state = { ...state, error: error.message, success: Boolean(Object.keys(state.rates).length) };
    console.error('Update failed:', error.stack || error.message);
    throw error;
  }).finally(() => {
    updatePromise = null;
  });

  return updatePromise;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on 0.0.0.0:${PORT}`);
  console.log(`Public Telegram channel: https://t.me/${CHANNEL}`);
});
