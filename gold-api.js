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
      const response = await fetch('https://api.gold-api.com/price/XAU');
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
    // Primary source: Nepal Rastra Bank official sell rate
    try {
      var today = new Date().toISOString().slice(0, 10);
      var nrbUrl = 'https://www.nrb.org.np/api/forex/v1/rates?page=1&per_page=5&from=' +
        today + '&to=' + today;
      var response = await fetch(nrbUrl);
      if (response.ok) {
        var data = await response.json();
        var payload = data.data && data.data.payload;
        if (payload && payload.length > 0) {
          var rates = payload[0].rates;
          for (var i = 0; i < rates.length; i++) {
            if (rates[i].currency && rates[i].currency.iso3 === 'USD') {
              var rate = parseFloat(rates[i].sell);
              if (!isNaN(rate) && rate > 0) return rate;
            }
          }
        }
        console.warn('fetchUsdNpr: USD not found in NRB response', data);
      } else {
        console.warn('fetchUsdNpr: NRB API status', response.status);
      }
    } catch (error) {
      console.warn('fetchUsdNpr: NRB API failed', error);
    }

    // Fallback source
    try {
      response = await fetch('https://api.frankfurter.dev/v2/rate/USD/NPR');
      if (response.ok) {
        var fData = await response.json();
        var fRate = parseFloat(fData.rate ?? fData.rates?.NPR ?? fData.npr);
        if (!isNaN(fRate) && fRate > 0) return fRate;
      }
    } catch (error) {
      console.warn('fetchUsdNpr: fallback source failed', error);
    }

    return null;
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

    // Primary: NRB API (returns official sell rates per date)
    try {
      var nrbUrl = 'https://www.nrb.org.np/api/forex/v1/rates?page=1&per_page=1000&from=' +
        encodeURIComponent(fromDate) + '&to=' + encodeURIComponent(toDate);
      var response = await fetch(nrbUrl);
      if (response.ok) {
        var data = await response.json();
        var payload = data.data && data.data.payload;
        if (payload && payload.length > 0) {
          var result = {};
          payload.forEach(function (day) {
            var dateStr = day.date ? day.date.slice(0, 10) : null;
            if (!dateStr) return;
            var rates = day.rates || [];
            for (var i = 0; i < rates.length; i++) {
              if (rates[i].currency && rates[i].currency.iso3 === 'USD') {
                var rate = parseFloat(rates[i].sell);
                if (!isNaN(rate) && rate > 0) result[dateStr] = rate;
                break;
              }
            }
          });
          if (Object.keys(result).length > 0) return result;
        }
      }
      console.warn('fetchHistoricalUsdNpr: NRB API did not return usable data');
    } catch (error) {
      console.warn('fetchHistoricalUsdNpr: NRB API failed', error);
    }

    // Fallback: Frankfurter API
    try {
      var url =
        'https://api.frankfurter.dev/v2/rates/USD/NPR?from=' +
        encodeURIComponent(fromDate) +
        '&to=' +
        encodeURIComponent(toDate);
      var response = await fetch(url);
      if (!response.ok) {
        console.warn('fetchHistoricalUsdNpr: fallback status', response.status);
        return {};
      }
      var data = await response.json();
      var result = {};

      if (Array.isArray(data)) {
        var nprByDate = {};
        var usdByDate = {};
        data.forEach(function (item) {
          if (item.quote === 'NPR' && item.rate > 0) nprByDate[item.date] = item.rate;
          if (item.quote === 'USD' && item.rate > 0) usdByDate[item.date] = item.rate;
        });
        Object.keys(nprByDate).forEach(function (date) {
          if (usdByDate[date]) {
            result[date] = nprByDate[date] / usdByDate[date];
          }
        });
        return result;
      }

      if (data.rate && data.date) {
        result[data.date] = parseFloat(data.rate);
        return result;
      }

      return result;
    } catch (error) {
      console.error('fetchHistoricalUsdNpr: fallback failed', error);
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
