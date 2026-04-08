#!/usr/bin/env node

/**
 * Incremental daily update script for historical gold price data.
 *
 * Reads existing data/historical-gold-data.json, fetches only NEW hourly
 * XAU/USD data (last 2 days from Yahoo Finance) and NRB exchange rates,
 * appends new entries, trims data older than 2 years, and writes back.
 *
 * Designed to run as a GitHub Actions daily cron job.
 *
 * Usage:   node scripts/update-daily-data.mjs
 */

import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const OUTPUT_FILE = join(DATA_DIR, 'historical-gold-data.json');

// ---------------------------------------------------------------------------
// Constants (must match fetch-historical-data.mjs)
// ---------------------------------------------------------------------------

const GRAMS_PER_TOLA = 11.6638;
const GRAMS_PER_TROY_OZ = 31.1035;
const CUSTOMS_DUTY = 0.10;
const DEFAULT_MARGIN = 0.013;
const TWO_YEARS_MS = 2 * 365.25 * 24 * 60 * 60 * 1000;

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

// ---------------------------------------------------------------------------
// Fetch hourly XAU/USD from Yahoo Finance (GC=F, last 2 days)
// ---------------------------------------------------------------------------

async function fetchYahooHourly() {
  console.log('[Yahoo] Fetching last 2 days hourly GC=F data...');

  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/GC=F?interval=1h&range=2d';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance returned ${res.status}`);
  }

  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error('No chart result from Yahoo');

  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];

  const entries = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const close = closes[i];
    if (ts == null || close == null || isNaN(close)) continue;
    entries.push({ timestamp: ts, xauUsd: Math.round(close * 100) / 100 });
  }

  console.log(`[Yahoo] Got ${entries.length} hourly entries.`);
  return entries;
}

// ---------------------------------------------------------------------------
// Fetch NRB exchange rates for a date range
// ---------------------------------------------------------------------------

async function fetchNRBRates(fromDate, toDate) {
  console.log(`[NRB] Fetching USD/NPR sell rates ${fromDate} to ${toDate}...`);
  const rates = {};
  let page = 1;

  while (true) {
    const url = `https://www.nrb.org.np/api/forex/v1/rates?page=${page}&per_page=100&from=${fromDate}&to=${toDate}`;
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load existing data
  let existing;
  try {
    existing = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${OUTPUT_FILE}: ${err.message}`);
    console.error('Run scripts/fetch-historical-data.mjs first to bootstrap the data.');
    process.exit(1);
  }

  const existingHourly = existing.hourly || []; // [[ts, xau, npr, tola], ...]
  const existingDaily = existing.daily || [];

  // Find the last timestamp we have
  const lastTs = existingHourly.length > 0
    ? existingHourly[existingHourly.length - 1][0]
    : 0;
  const lastDate = existingDaily.length > 0
    ? existingDaily[existingDaily.length - 1].date
    : '2024-01-01';

  console.log(`\nExisting data: ${existingHourly.length} hourly, ${existingDaily.length} daily entries`);
  console.log(`Last hourly timestamp: ${lastTs} (${new Date(lastTs * 1000).toISOString()})`);
  console.log(`Last daily date: ${lastDate}\n`);

  // Fetch new data
  const today = formatDate(new Date());
  const threeDaysAgo = formatDate(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));

  const [yahooEntries, nrbRates] = await Promise.all([
    fetchYahooHourly(),
    fetchNRBRates(threeDaysAgo, today),
  ]);

  // Find the last known NRB rate as fallback for days NRB hasn't published yet
  let fallbackNprRate = null;
  for (let i = existingDaily.length - 1; i >= 0; i--) {
    if (existingDaily[i].usdNpr) {
      fallbackNprRate = existingDaily[i].usdNpr;
      break;
    }
  }

  // Build sorted list of all known NRB dates for lookup
  const allNrbRates = {};
  for (const d of existingDaily) {
    if (d.usdNpr) allNrbRates[d.date] = d.usdNpr;
  }
  Object.assign(allNrbRates, nrbRates); // new rates override
  const nrbDates = Object.keys(allNrbRates).sort();

  function getNRBRate(dateStr) {
    if (allNrbRates[dateStr]) return allNrbRates[dateStr];
    // Find closest previous date
    for (let i = nrbDates.length - 1; i >= 0; i--) {
      if (nrbDates[i] <= dateStr) return allNrbRates[nrbDates[i]];
    }
    return fallbackNprRate;
  }

  // Filter to only new entries (after our last timestamp)
  const newEntries = yahooEntries.filter(e => e.timestamp > lastTs);
  console.log(`[Merge] ${newEntries.length} new hourly entries to add.`);

  if (newEntries.length === 0) {
    console.log('No new data to add. Exiting.');
    process.exit(0);
  }

  // Convert new entries to hourly format [ts, xau, npr, tola]
  const newHourly = [];
  for (const entry of newEntries) {
    const dateStr = formatDate(new Date(entry.timestamp * 1000));
    const usdNpr = getNRBRate(dateStr);
    if (!usdNpr) {
      console.warn(`  Skipping ts=${entry.timestamp}: no NRB rate for ${dateStr}`);
      continue;
    }
    newHourly.push([
      entry.timestamp,
      entry.xauUsd,
      usdNpr,
      computeNprPerTola(entry.xauUsd, usdNpr),
    ]);
  }

  // Append new hourly data
  const mergedHourly = [...existingHourly, ...newHourly];

  // Trim entries older than 2 years
  const cutoffTs = Math.floor((Date.now() - TWO_YEARS_MS) / 1000);
  const trimmedHourly = mergedHourly.filter(h => h[0] >= cutoffTs);

  // Rebuild daily summary from all hourly data
  const dailyMap = {};
  for (const [ts, xau, npr, tola] of trimmedHourly) {
    const dateStr = formatDate(new Date(ts * 1000));
    if (!dailyMap[dateStr]) {
      dailyMap[dateStr] = {
        xauOpen: xau, xauClose: xau, xauHigh: xau, xauLow: xau,
        npr,
        tolaOpen: tola, tolaClose: tola, tolaHigh: tola, tolaLow: tola,
      };
    } else {
      const d = dailyMap[dateStr];
      d.xauClose = xau;
      d.tolaClose = tola;
      if (xau > d.xauHigh) d.xauHigh = xau;
      if (xau < d.xauLow) d.xauLow = xau;
      if (tola > d.tolaHigh) d.tolaHigh = tola;
      if (tola < d.tolaLow) d.tolaLow = tola;
    }
  }

  // Preserve fenegosida values from existing daily data
  const fenegosidaMap = {};
  for (const d of existingDaily) {
    if (d.fenegosida) fenegosidaMap[d.date] = d.fenegosida;
  }

  const dailyData = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      xauOpen: d.xauOpen, xauClose: d.xauClose, xauHigh: d.xauHigh, xauLow: d.xauLow,
      usdNpr: d.npr,
      nprPerTola: d.tolaClose,
      tolaHigh: d.tolaHigh, tolaLow: d.tolaLow,
      fenegosida: fenegosidaMap[date] || null,
    }));

  // Build output
  const firstDate = dailyData[0]?.date || formatDate(new Date(cutoffTs * 1000));
  const output = {
    generated: formatDate(new Date()),
    range: { from: firstDate, to: today },
    params: existing.params,
    daily: dailyData,
    hourly: trimmedHourly,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(output));

  const sizeMB = (Buffer.byteLength(JSON.stringify(output)) / 1024 / 1024).toFixed(2);
  console.log(`\n[Done] Updated ${OUTPUT_FILE}`);
  console.log(`  Daily entries:  ${dailyData.length}`);
  console.log(`  Hourly entries: ${trimmedHourly.length}`);
  console.log(`  New hourly added: ${newHourly.length}`);
  console.log(`  File size: ${sizeMB} MB\n`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
