const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');
const { parseRates, hasCoreRates } = require('./rates');

const execFileAsync = promisify(execFile);

// The rate card is a fixed 957x1280 layout. We intentionally use one full-image OCR pass
// instead of 10 serial region OCR calls: the old implementation could easily exceed the
// request timeout on Render. One whole-card pass is much faster and the parser below maps
// values by their labels/order.
async function prepareImage(buffer, variant = 0) {
  const input = sharp(buffer, { failOn: 'none' });
  const meta = await input.metadata();
  const width = Math.max(1800, meta.width || 1800);

  let pipeline = input.resize({ width, withoutEnlargement: false }).grayscale();
  if (variant === 0) {
    pipeline = pipeline.normalize().sharpen({ sigma: 1.0 });
  } else {
    pipeline = pipeline.modulate({ brightness: 1.12 }).linear(1.4, -25).sharpen({ sigma: 0.8 });
  }
  return pipeline.png().toBuffer();
}

async function ocrBuffer(buffer, psm = '6') {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-ocr-'));
  const input = path.join(dir, `${id}.png`);

  try {
    await fs.writeFile(input, buffer);
    const { stdout, stderr } = await execFileAsync('tesseract', [
      input,
      'stdout',
      '-l',
      'rus+eng',
      '--psm',
      String(psm),
      '--dpi',
      '300',
      '-c',
      'user_defined_dpi=300'
    ], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });

    return {
      text: String(stdout || '').trim(),
      stderr: String(stderr || '').trim()
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function recognizeRates(originalBuffer) {
  const errors = [];
  let rawText = '';
  const attempts = [];

  // Fast primary pass.
  try {
    const prepared = await prepareImage(originalBuffer, 0);
    const result = await ocrBuffer(prepared, '6');
    rawText = result.text;
    attempts.push({ psm: 6, variant: 0, chars: rawText.length, stderr: result.stderr });
  } catch (error) {
    errors.push(`primary OCR: ${error.message}`);
  }

  let rates = parseRates({}, rawText);

  // Rescue pass only if the main required values were not found.
  if (!hasCoreRates(rates)) {
    try {
      const prepared = await prepareImage(originalBuffer, 1);
      const result = await ocrBuffer(prepared, '11');
      if (result.text.length > rawText.length) rawText = result.text;
      attempts.push({ psm: 11, variant: 1, chars: result.text.length, stderr: result.stderr });
      rates = parseRates({}, rawText);
    } catch (error) {
      errors.push(`rescue OCR: ${error.message}`);
    }
  }

  if (!hasCoreRates(rates)) {
    const detail = errors.length ? ` ${errors.join('; ')}` : '';
    throw new Error(`OCR не распознал обязательные курсы.${detail}`);
  }

  return {
    rates,
    rawText,
    regions: {},
    errors,
    attempts
  };
}

module.exports = { recognizeRates };
