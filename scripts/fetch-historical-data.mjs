#!/usr/bin/env node

/**
 * One-time script to fetch and store historical gold price data.
 *
 * Data sources:
 *   - Hourly XAU/USD: Hugging Face dataset (bulk, up to ~Jul 2025) +
 *                      pre-fetched Yahoo Finance gap data (Jul 2025 – Apr 2026)
 *   - Daily USD/NPR:  Nepal Rastra Bank official sell rate
 *   - Daily NPR/tola: Fenegosida (verification / official Nepal price)
 *
 * Prerequisites:
 *   - data/XAU_1h_data.jsonl  (Hugging Face hourly gold data)
 *   - data/yahoo_gap_data.json (Yahoo Finance gap data, [timestamp, close] pairs)
 *
 * Output:  data/historical-gold-data.json
 *
 * Usage:   node scripts/fetch-historical-data.mjs
 */

import { writeFileSync, readFileSync, createReadStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const OUTPUT_FILE = join(DATA_DIR, 'historical-gold-data.json');
const HF_FILE = join(DATA_DIR, 'XAU_1h_data.jsonl');
const YAHOO_GAP_FILE = join(DATA_DIR, 'yahoo_gap_data.json');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRAMS_PER_TOLA = 11.6638;
const GRAMS_PER_TROY_OZ = 31.1035;
const CUSTOMS_DUTY = 0.10;
const DEFAULT_MARGIN = 0.013;

const TWO_YEARS_MS = 2 * 365.25 * 24 * 60 * 60 * 1000;

const BS_MONTHS = [
  'Baisakh', 'Jestha', 'Ashad', 'Shrawan', 'Bhadra', 'Ashoj',
  'Kartik', 'Mansir', 'Poush', 'Magh', 'Falgun', 'Chaitra',
];

const BS_YEAR_DATA = {
  2080: { startAD: '2023-04-14', days: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30] },
  2081: { startAD: '2024-04-13', days: [31, 32, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30] },
  2082: { startAD: '2025-04-14', days: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30] },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatDate(d) { return d.toISOString().slice(0, 10); }

function computeNprPerTola(xauUsd, usdNpr) {
  const perTolaUsd = (xauUsd * GRAMS_PER_TOLA) / GRAMS_PER_TROY_OZ;
  const perTolaNpr = perTolaUsd * usdNpr;
  const afterDuty = perTolaNpr * (1 + CUSTOMS_DUTY);
  return Math.round(afterDuty * (1 + DEFAULT_MARGIN));
}

function bsToAD(bsYear, bsMonthIndex, bsDay) {
  const yearData = BS_YEAR_DATA[bsYear];
  if (!yearData) return null;
  let daysOffset = bsDay - 1;
  for (let m = 0; m < bsMonthIndex; m++) daysOffset += yearData.days[m];
  const start = new Date(yearData.startAD + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() + daysOffset);
  return formatDate(start);
}

// ---------------------------------------------------------------------------
// NRB Exchange Rates
// ---------------------------------------------------------------------------

async function fetchNRBRates(fromDate, toDate) {
  console.log(`[NRB] Fetching USD/NPR sell rates ${fromDate} to ${toDate}...`);
  const rates = {};
  let page = 1;

  while (true) {
    const url = `https://www.nrb.org.np/api/forex/v1/rates?page=${page}&per_page=100&from=${fromDate}&to=${toDate}`;
    console.log(`  page ${page}...`);

    const res = await fetch(url);
    if (!res.ok) { console.error(`  NRB API returned ${res.status}`); break; }

    const json = await res.json();
    const payload = json.data?.payload;
    if (!payload || payload.length === 0) break;

    for (const day of payload) {
      const dateStr = day.date?.slice(0, 10);
      if (!dateStr) continue;
      const usdEntry = (day.rates || []).find(r => r.currency?.iso3 === 'USD');
      if (usdEntry) {
        const sell = parseFloat(usdEntry.sell);
        if (!isNaN(sell) && sell > 0) rates[dateStr] = sell;
      }
    }

    const pagination = json.pagination || json.data?.pagination;
    const totalPages = pagination?.pages ?? pagination?.total_pages ?? 1;
    if (page >= totalPages) break;
    page++;
    await sleep(500);
  }

  console.log(`[NRB] Got ${Object.keys(rates).length} daily rates.`);
  return rates;
}

// ---------------------------------------------------------------------------
// Gold price data: Hugging Face JSONL + Yahoo gap JSON
// ---------------------------------------------------------------------------

async function loadHFData(fromDate) {
  console.log(`[HuggingFace] Loading hourly data from ${fromDate}...`);
  const entries = [];
  const fromTs = new Date(fromDate + 'T00:00:00Z').getTime() / 1000;

  const rl = createInterface({ input: createReadStream(HF_FILE), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const [datePart, timePart] = obj.Date.split(' ');
      const isoDate = datePart.replace(/\./g, '-');
      const ts = Math.floor(new Date(`${isoDate}T${timePart}:00Z`).getTime() / 1000);
      if (ts < fromTs || isNaN(ts)) continue;
      if (obj.Close == null || isNaN(obj.Close)) continue;
      entries.push({ timestamp: ts, xauUsd: Math.round(obj.Close * 100) / 100 });
    } catch { /* skip malformed */ }
  }

  console.log(`[HuggingFace] Loaded ${entries.length} hourly entries.`);
  return entries;
}

function loadYahooGap() {
  console.log(`[Yahoo] Loading pre-fetched gap data...`);
  try {
    const raw = readFileSync(YAHOO_GAP_FILE, 'utf8');
    const data = JSON.parse(raw);
    const entries = (data.entries || []).map(([ts, close]) => ({
      timestamp: ts,
      xauUsd: Math.round(close * 100) / 100,
    }));
    console.log(`[Yahoo] Loaded ${entries.length} hourly entries (${data.dataGranularity}).`);
    return entries;
  } catch (err) {
    console.warn(`[Yahoo] Could not load gap data: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fenegosida – Official Nepal Gold Prices (verification)
// ---------------------------------------------------------------------------

async function fetchFenegosidaMonth(bsYear, monthName) {
  const body = `year=${bsYear}&month=${encodeURIComponent(monthName)}&submit=Submit`;
  const res = await fetch('https://fenegosida.org/rate-history.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return [];
  const html = await res.text();

  // Only parse the PER 1 TOLA table (stop before PER 10 GRM)
  const tolaStart = html.indexOf('PER 1 TOLA');
  const grmStart = html.indexOf('PER 10 GRM');
  if (tolaStart === -1) return [];
  const section = html.substring(tolaStart, grmStart > tolaStart ? grmStart : undefined);

  const results = [];
  const rowRegex = /<tr[^>]*>\s*<th[^>]*>(\d+)<\/th>\s*<td[^>]*>FINE GOLD \(9999\):\s*(?:<b>)?([\d,]+)/gi;
  let match;
  while ((match = rowRegex.exec(section)) !== null) {
    const day = parseInt(match[1], 10);
    const price = parseInt(match[2].replace(/,/g, ''), 10);
    if (day > 0 && price > 0) results.push({ day, fineGoldPerTola: price });
  }
  return results;
}

async function fetchAllFenegosida() {
  console.log('[Fenegosida] Scraping official Nepal gold prices...');
  const prices = {};

  for (const bsYear of [2080, 2081, 2082]) {
    for (let mi = 0; mi < 12; mi++) {
      const monthName = BS_MONTHS[mi];
      console.log(`  ${bsYear} ${monthName}...`);
      try {
        const rows = await fetchFenegosidaMonth(bsYear, monthName);
        for (const { day, fineGoldPerTola } of rows) {
          const adDate = bsToAD(bsYear, mi, day);
          if (adDate) prices[adDate] = fineGoldPerTola;
        }
      } catch (err) { console.warn(`  Error: ${err.message}`); }
      await sleep(1000);
    }
  }

  console.log(`[Fenegosida] Got ${Object.keys(prices).length} daily prices.`);
  return prices;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - TWO_YEARS_MS);
  const fromStr = formatDate(startDate);
  const toStr = formatDate(endDate);

  console.log(`\nFetching historical gold data: ${fromStr} to ${toStr}\n`);

  // Load gold data from local files + fetch NRB + fenegosida in parallel
  const [hfEntries, nrbRates, fenegosidaPrices] = await Promise.all([
    loadHFData(fromStr),
    fetchNRBRates(fromStr, toStr),
    fetchAllFenegosida(),
  ]);

  const yahooEntries = loadYahooGap();

  // Merge: HF data first, then Yahoo gap (deduplicate by taking later source for overlaps)
  const tsSet = new Set();
  const allEntries = [];
  // Add Yahoo gap first (higher priority for overlapping timestamps)
  for (const e of yahooEntries) tsSet.add(e.timestamp);
  // Add HF entries that don't overlap
  for (const e of hfEntries) {
    if (!tsSet.has(e.timestamp)) {
      allEntries.push(e);
      tsSet.add(e.timestamp);
    }
  }
  // Then add all Yahoo entries
  allEntries.push(...yahooEntries);
  // Sort by timestamp
  allEntries.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`\n[Merge] Total gold hourly entries: ${allEntries.length}`);

  // Build the combined hourly dataset with NRB rates
  console.log('[Build] Computing hourly NPR/tola...');

  const nrbDates = Object.keys(nrbRates).sort();
  function getNRBRate(dateStr) {
    if (nrbRates[dateStr]) return nrbRates[dateStr];
    for (let i = nrbDates.length - 1; i >= 0; i--) {
      if (nrbDates[i] <= dateStr) return nrbRates[nrbDates[i]];
    }
    return null;
  }

  const hourlyData = [];
  for (const entry of allEntries) {
    const dt = new Date(entry.timestamp * 1000);
    const dateStr = formatDate(dt);
    const usdNpr = getNRBRate(dateStr);
    if (!usdNpr) continue;
    hourlyData.push({
      ts: entry.timestamp,
      xau: entry.xauUsd,
      npr: usdNpr,
      tola: computeNprPerTola(entry.xauUsd, usdNpr),
    });
  }

  // Build daily summary
  const dailyMap = {};
  for (const h of hourlyData) {
    const dateStr = formatDate(new Date(h.ts * 1000));
    if (!dailyMap[dateStr]) {
      dailyMap[dateStr] = {
        xauOpen: h.xau, xauClose: h.xau, xauHigh: h.xau, xauLow: h.xau,
        npr: h.npr,
        tolaOpen: h.tola, tolaClose: h.tola, tolaHigh: h.tola, tolaLow: h.tola,
      };
    } else {
      const d = dailyMap[dateStr];
      d.xauClose = h.xau;
      d.tolaClose = h.tola;
      if (h.xau > d.xauHigh) d.xauHigh = h.xau;
      if (h.xau < d.xauLow) d.xauLow = h.xau;
      if (h.tola > d.tolaHigh) d.tolaHigh = h.tola;
      if (h.tola < d.tolaLow) d.tolaLow = h.tola;
    }
  }

  const dailyData = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      xauOpen: d.xauOpen, xauClose: d.xauClose, xauHigh: d.xauHigh, xauLow: d.xauLow,
      usdNpr: d.npr,
      nprPerTola: d.tolaClose,
      tolaHigh: d.tolaHigh, tolaLow: d.tolaLow,
      fenegosida: fenegosidaPrices[date] || null,
    }));

  const output = {
    generated: formatDate(new Date()),
    range: { from: fromStr, to: toStr },
    params: { gramsPerTola: GRAMS_PER_TOLA, gramsPerTroyOz: GRAMS_PER_TROY_OZ, customsDuty: CUSTOMS_DUTY, defaultMargin: DEFAULT_MARGIN },
    daily: dailyData,
    // Compact hourly: [timestamp, xauUsd, usdNpr, nprPerTola]
    hourly: hourlyData.map(h => [h.ts, h.xau, h.npr, h.tola]),
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(output));

  const sizeMB = (Buffer.byteLength(JSON.stringify(output)) / 1024 / 1024).toFixed(2);
  console.log(`\n[Done] Wrote ${OUTPUT_FILE}`);
  console.log(`  Daily entries:  ${dailyData.length}`);
  console.log(`  Hourly entries: ${hourlyData.length}`);
  console.log(`  Fenegosida verification points: ${Object.keys(fenegosidaPrices).length}`);
  console.log(`  File size: ${sizeMB} MB\n`);

  // Verification: compare computed price vs fenegosida official price
  console.log('Verification (computed vs fenegosida):');
  let verified = 0;
  for (const d of dailyData) {
    if (d.fenegosida && verified < 15) {
      const diff = d.nprPerTola - d.fenegosida;
      const pct = ((diff / d.fenegosida) * 100).toFixed(1);
      console.log(`  ${d.date}: computed=${d.nprPerTola} fenegosida=${d.fenegosida} diff=${diff > 0 ? '+' : ''}${diff} (${pct}%)`);
      verified++;
    }
  }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
