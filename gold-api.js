/**
 * Gold API Module
 * Fetches live and historical gold prices (XAU/USD) and exchange rates (USD/NPR).
 * Computes Nepali tola pricing with duty and market margin.
 */
(function () {
  'use strict';

  const CACHE_KEY = 'gold_market_data';
  const CACHE_MAX_AGE = 30 * 60 * 1000; // 30 minutes

  /**
   * Fetch XAU/USD spot price.
   * @returns {Promise<number|null>} Price in USD or null on failure.
   */
  async function fetchXauUsd() {
    try {
      const response = await fetch('https://api.gold-api.com/spot/quote/XAU/USD');
      if (!response.ok) {
        console.warn('fetchXauUsd: response status', response.status);
        return null;
      }
      const data = await response.json();
      const price = parseFloat(data.price ?? data.mid ?? data.ask);
      if (isNaN(price) || price <= 0) {
        console.warn('fetchXauUsd: invalid price in response', data);
        return null;
      }
      return price;
    } catch (error) {
      console.error('fetchXauUsd: request failed', error);
      return null;
    }
  }

  /**
   * Fetch USD/NPR exchange rate with fallback source.
   * @returns {Promise<number|null>} NPR per 1 USD or null on failure.
   */
  async function fetchUsdNpr() {
    // Primary source
    try {
      const response = await fetch('https://api.frankfurter.dev/v2/rate/USD/NPR');
      if (response.ok) {
        const data = await response.json();
        const rate = parseFloat(data.rates?.NPR ?? data.rate ?? data.npr);
        if (!isNaN(rate) && rate > 0) {
          return rate;
        }
        console.warn('fetchUsdNpr: invalid rate from primary source', data);
      } else {
        console.warn('fetchUsdNpr: primary source status', response.status);
      }
    } catch (error) {
      console.warn('fetchUsdNpr: primary source failed', error);
    }

    // Fallback source
    try {
      const response = await fetch(
        'https://cdn.jsdelivr.net/gh/fawazahmed0/currency-api@1/latest/currencies/usd/npr.json'
      );
      if (!response.ok) {
        console.warn('fetchUsdNpr: fallback source status', response.status);
        return null;
      }
      const data = await response.json();
      const rate = parseFloat(data.npr);
      if (isNaN(rate) || rate <= 0) {
        console.warn('fetchUsdNpr: invalid rate from fallback source', data);
        return null;
      }
      return rate;
    } catch (error) {
      console.error('fetchUsdNpr: fallback source failed', error);
      return null;
    }
  }

  /**
   * Convert XAU/USD + USD/NPR into NPR per tola with duty and margin.
   * @param {number} xauUsd   - Gold price per troy ounce in USD.
   * @param {number} usdNpr   - Exchange rate: NPR per 1 USD.
   * @param {number} marketMargin - Percentage margin (default 1.3).
   * @returns {number} NPR per tola after duty and margin.
   */
  function computeNprPerTola(xauUsd, usdNpr, marketMargin) {
    var perTolaUsd = (xauUsd * 11.6638) / 31.1035;
    var perTolaNpr = perTolaUsd * usdNpr;
    var afterDuty = perTolaNpr * 1.10;
    return afterDuty * (1 + marketMargin / 100);
  }

  /**
   * Read cached market data from localStorage.
   * @returns {object|null} Cached data or null if missing / expired.
   */
  function getCachedData() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (!cached || typeof cached.timestamp !== 'number') return null;
      if (Date.now() - cached.timestamp > CACHE_MAX_AGE) return null;
      return cached;
    } catch (error) {
      console.warn('getCachedData: failed to read cache', error);
      return null;
    }
  }

  /**
   * Check whether the cached data is stale (older than CACHE_MAX_AGE).
   * Returns true when there is no cache at all.
   * @returns {boolean}
   */
  function isCacheStale() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return true;
      var cached = JSON.parse(raw);
      if (!cached || typeof cached.timestamp !== 'number') return true;
      return Date.now() - cached.timestamp > CACHE_MAX_AGE;
    } catch (error) {
      return true;
    }
  }

  /**
   * Write market data to localStorage cache.
   * @param {object} data
   */
  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (error) {
      console.warn('saveCache: could not persist cache', error);
    }
  }

  /**
   * Retrieve any existing cached data regardless of staleness.
   * Used as a last-resort fallback when live fetches fail.
   * @returns {object|null}
   */
  function getAnyCachedData() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (!cached || typeof cached.timestamp !== 'number') return null;
      return cached;
    } catch (error) {
      return null;
    }
  }

  /**
   * Fetch live gold + exchange data, compute tola price, and cache the result.
   * Falls back to cached data when network requests fail.
   * @param {number} [marketMargin=1.3] - Market margin percentage.
   * @returns {Promise<object|null>} { xauUsd, usdNpr, nprPerTola, timestamp }
   */
  async function fetchLiveData(marketMargin) {
    if (marketMargin === undefined || marketMargin === null) {
      marketMargin = 1.3;
    }

    try {
      var results = await Promise.all([fetchXauUsd(), fetchUsdNpr()]);
      var xauUsd = results[0];
      var usdNpr = results[1];

      if (xauUsd === null || usdNpr === null) {
        console.warn('fetchLiveData: one or both prices unavailable, using cache');
        return getAnyCachedData();
      }

      var nprPerTola = computeNprPerTola(xauUsd, usdNpr, marketMargin);

      var payload = {
        xauUsd: xauUsd,
        usdNpr: usdNpr,
        nprPerTola: nprPerTola,
        timestamp: Date.now(),
      };

      saveCache(payload);
      return payload;
    } catch (error) {
      console.error('fetchLiveData: unexpected error', error);
      return getAnyCachedData();
    }
  }

  /**
   * Fetch historical OHLC data for XAU/USD.
   * @param {string} period - One of '1W', '1M', '3M', '6M', '1Y'.
   * @returns {Promise<Array<{date: string, close: number}>>}
   */
  async function fetchHistoricalXau(period) {
    var validPeriods = ['1W', '1M', '3M', '6M', '1Y'];
    if (validPeriods.indexOf(period) === -1) {
      console.warn('fetchHistoricalXau: invalid period', period);
      return [];
    }

    try {
      var url = 'https://api.gold-api.com/spot/ohlc/XAU/USD?period=' + encodeURIComponent(period);
      var response = await fetch(url);
      if (!response.ok) {
        console.warn('fetchHistoricalXau: response status', response.status);
        return [];
      }
      var data = await response.json();
      var items = Array.isArray(data) ? data : data.data || data.ohlc || [];
      if (!Array.isArray(items)) return [];

      return items
        .map(function (item) {
          var close = parseFloat(item.close ?? item.Close ?? item.price);
          var date = item.date || item.Date || item.time || item.timestamp || '';
          if (isNaN(close) || !date) return null;
          return { date: String(date), close: close };
        })
        .filter(function (entry) {
          return entry !== null;
        });
    } catch (error) {
      console.error('fetchHistoricalXau: request failed', error);
      return [];
    }
  }

  /**
   * Fetch historical USD/NPR exchange rates for a date range.
   * @param {string} fromDate - Start date (YYYY-MM-DD).
   * @param {string} toDate   - End date (YYYY-MM-DD).
   * @returns {Promise<Object<string, number>>} Map of date string to NPR rate.
   */
  async function fetchHistoricalUsdNpr(fromDate, toDate) {
    if (!fromDate || !toDate) {
      console.warn('fetchHistoricalUsdNpr: fromDate and toDate are required');
      return {};
    }

    try {
      var url =
        'https://api.frankfurter.dev/v2/rate/USD/NPR?from=' +
        encodeURIComponent(fromDate) +
        '&to=' +
        encodeURIComponent(toDate);
      var response = await fetch(url);
      if (!response.ok) {
        console.warn('fetchHistoricalUsdNpr: response status', response.status);
        return {};
      }
      var data = await response.json();

      // The API may return rates nested under a "rates" key or at the top level.
      var ratesObj = data.rates || data;
      var result = {};

      Object.keys(ratesObj).forEach(function (dateKey) {
        var entry = ratesObj[dateKey];
        var rate;
        if (typeof entry === 'number') {
          rate = entry;
        } else if (entry && typeof entry === 'object') {
          rate = parseFloat(entry.NPR ?? entry.npr ?? Object.values(entry)[0]);
        } else {
          return;
        }
        if (!isNaN(rate) && rate > 0) {
          result[dateKey] = rate;
        }
      });

      return result;
    } catch (error) {
      console.error('fetchHistoricalUsdNpr: request failed', error);
      return {};
    }
  }

  /**
   * Find the closest available NPR rate for a given date string.
   * Looks for an exact match first, then searches nearby dates within 7 days.
   * @param {string} targetDate - YYYY-MM-DD
   * @param {Object<string, number>} nprRates
   * @returns {number|null}
   */
  function findClosestRate(targetDate, nprRates) {
    if (nprRates[targetDate] !== undefined) {
      return nprRates[targetDate];
    }

    var targetTime = new Date(targetDate).getTime();
    if (isNaN(targetTime)) return null;

    var closestDate = null;
    var closestDiff = Infinity;

    Object.keys(nprRates).forEach(function (dateKey) {
      var diff = Math.abs(new Date(dateKey).getTime() - targetTime);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestDate = dateKey;
      }
    });

    // Only match within 7 days
    if (closestDate && closestDiff <= 7 * 24 * 60 * 60 * 1000) {
      return nprRates[closestDate];
    }

    return null;
  }

  /**
   * Combine historical XAU prices with historical NPR rates to produce
   * NPR-per-tola values over time.
   * @param {Array<{date: string, close: number}>} xauHistory
   * @param {Object<string, number>} nprRates - Date-to-rate map.
   * @param {number} [marketMargin=1.3]
   * @returns {Array<{date: string, nprPerTola: number, xauUsd: number, usdNpr: number}>}
   */
  function computeHistoricalNprPerTola(xauHistory, nprRates, marketMargin) {
    if (marketMargin === undefined || marketMargin === null) {
      marketMargin = 1.3;
    }
    if (!Array.isArray(xauHistory) || !nprRates || typeof nprRates !== 'object') {
      return [];
    }

    var results = [];

    xauHistory.forEach(function (point) {
      if (!point || typeof point.close !== 'number' || !point.date) return;

      // Normalize date to YYYY-MM-DD for matching
      var dateStr = String(point.date).slice(0, 10);
      var usdNpr = findClosestRate(dateStr, nprRates);
      if (usdNpr === null) return;

      var nprPerTola = computeNprPerTola(point.close, usdNpr, marketMargin);

      results.push({
        date: dateStr,
        nprPerTola: nprPerTola,
        xauUsd: point.close,
        usdNpr: usdNpr,
      });
    });

    return results;
  }

  // Expose public API
  window.GoldAPI = {
    fetchLiveData: fetchLiveData,
    getCachedData: getCachedData,
    isCacheStale: isCacheStale,
    fetchHistoricalXau: fetchHistoricalXau,
    fetchHistoricalUsdNpr: fetchHistoricalUsdNpr,
    computeHistoricalNprPerTola: computeHistoricalNprPerTola,
  };
})();
