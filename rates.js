const RATE_KEYS = [
  'USD_SWIFT',
  'USD_IDUBID',
  'JPY_INTERNAL',
  'JPY_SWIFT',
  'JPY_CASH',
  'JPY_QR',
  'CNY',
  'KRW',
  'THB',
  'AED'
];

function normalizeOcr(text) {
  return String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[，]/g, ',')
    .replace(/[：]/g, ':')
    .replace(/[Оо]/g, '0')
    .replace(/[Зз]/g, '3')
    .replace(/[Аа]/g, 'A')
    .replace(/[ІіLl]/g, '1')
    .replace(/[Ѕs]/g, '5')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function numberTokens(text) {
  const normalized = normalizeOcr(text).replace(/,/g, '.');
  return [...normalized.matchAll(/\d+(?:\.\d+)?/g)]
    .map(m => Number(m[0]))
    .filter(Number.isFinite);
}

function valid(value, max) {
  return Number.isFinite(value) && value > 0 && value < max;
}

function round6(value) {
  return Number(value.toFixed(6));
}

function allMatches(text, regex) {
  return [...text.matchAll(regex)].map(m => Number(m[1])).filter(Number.isFinite);
}

function pickAfter(text, re, transform = x => x, max = 1000) {
  const m = text.match(re);
  if (!m) return null;
  const n = transform(Number(m[1]));
  return valid(n, max) ? n : null;
}

function parseRates(_regions = {}, rawText = '') {
  let text = normalizeOcr(rawText)
    .replace(/,/g, '.')
    // OCR often drops spaces between the leading 1 and currency.
    .replace(/(\d)(USD|JPY|CNY|THB|KRW|AED)/gi, '$1 $2')
    .replace(/(1000|100)\s*(KRW|JPY)/gi, '$1 $2');

  const result = {};

  // Straightforward currencies.
  let v = pickAfter(text, /1000\s*KRW\s*=\s*(\d+(?:\.\d+)?)/i, x => x / 1000, 1);
  if (v != null) result.KRW = round6(v);

  v = pickAfter(text, /1\s*A[EЕ]D\s*=\s*(\d+(?:\.\d+)?)/i, x => x, 1000);
  if (v != null) result.AED = round6(v);

  v = pickAfter(text, /1\s*THB\s*=\s*(\d+(?:\.\d+)?)/i, x => x, 100);
  if (v != null) result.THB = round6(v);

  v = pickAfter(text, /1\s*(?:CNY|VON)\s*=\s*(\d+(?:\.\d+)?)/i, x => x, 100);
  if (v != null) result.CNY = round6(v);

  // CNY is occasionally OCR'd as "VON 13.45" or "CNY 13.45" without '='.
  if (result.CNY == null) {
    const m = text.match(/(?:CNY|VON)\s*=?\s*(\d+\.\d+)/i);
    if (m && valid(Number(m[1]), 100)) result.CNY = round6(Number(m[1]));
  }

  // USD appears exactly twice on this card: SWIFT first, IDUBID second.
  const usd = allMatches(text, /1\s*USD\s*=\s*(\d+(?:\.\d+)?)/gi);
  if (usd.length >= 1 && valid(usd[0], 500)) result.USD_SWIFT = round6(usd[0]);
  if (usd.length >= 2 && valid(usd[1], 500)) result.USD_IDUBID = round6(usd[1]);

  // JPY appears four times on the card in stable visual order:
  // internal, SWIFT, AFA cash, AFA QR. Values are quoted per 100 JPY.
  const jpyPer100 = allMatches(text, /100\s*JPY\s*=\s*(\d+(?:\.\d+)?)/gi)
    .filter(n => valid(n, 1000));
  if (jpyPer100.length >= 1) result.JPY_INTERNAL = round6(jpyPer100[0] / 100);
  if (jpyPer100.length >= 2) result.JPY_SWIFT = round6(jpyPer100[1] / 100);

  // OCR sometimes loses the "100" on the lower AFA rows and leaves "JPY = 57.30".
  const looseJpy = allMatches(text, /(?:^|\s)JPY\s*=\s*(\d+(?:\.\d+)?)/gi)
    .filter(n => valid(n, 1000));
  const remainingJpy = looseJpy.filter(n => !jpyPer100.includes(n));
  if (remainingJpy.length >= 1) result.JPY_CASH = round6(remainingJpy[0] / 100);
  if (remainingJpy.length >= 2) result.JPY_QR = round6(remainingJpy[1] / 100);

  // Fallback for the common OCR output where all JPY rows are captured as "JPY = x".
  if (result.JPY_INTERNAL == null || result.JPY_SWIFT == null || result.JPY_CASH == null || result.JPY_QR == null) {
    const anyJpy = allMatches(text, /(?:100\s*)?JPY\s*=\s*(\d+(?:\.\d+)?)/gi)
      .filter(n => valid(n, 1000));
    if (anyJpy.length >= 4) {
      result.JPY_INTERNAL = result.JPY_INTERNAL ?? round6(anyJpy[0] / 100);
      result.JPY_SWIFT = result.JPY_SWIFT ?? round6(anyJpy[1] / 100);
      result.JPY_CASH = result.JPY_CASH ?? round6(anyJpy[2] / 100);
      result.JPY_QR = result.JPY_QR ?? round6(anyJpy[3] / 100);
    }
  }

  // Compatibility aliases used by calc-cardash.
  if (result.JPY_CASH != null) result.JPY_AFA_CASH = result.JPY_CASH;
  if (result.JPY_QR != null) result.JPY_AFA_QR = result.JPY_QR;
  if (result.USD_SWIFT != null) result.USD = result.USD_SWIFT;

  return result;
}

function hasCoreRates(rates) {
  return ['KRW', 'AED', 'CNY', 'THB'].every(key => Number.isFinite(rates[key]))
    && ['USD_SWIFT', 'USD_IDUBID'].some(key => Number.isFinite(rates[key]));
}

module.exports = { RATE_KEYS, parseRates, hasCoreRates, normalizeOcr, numberTokens };
