// ============================================================================
// Gold Investment Tracker — Main Application (Alpine.js)
// Nepal Gold Market P/L Calculator, Portfolio Manager & Live Market Data
// ============================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SELLER_MARGIN = 0.05;
const CUSTOMS_DUTY = 0.10;
const GRAMS_PER_TOLA = 11.6638;
const GRAMS_PER_TROY_OZ = 31.1035;
const DEFAULT_MARKET_MARGIN = 0.013;
const PROFIT_MARGINS = [3, 5, 7, 8, 10, 12, 15, 20, 25];
const LOSS_MARGINS = [5, 7, 10];

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------
function fmt(n) {
  return n.toLocaleString('en-NP', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  return Math.round(Math.abs(d2 - d1) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Buy cost calculation (shared between quick calc and portfolio)
// ---------------------------------------------------------------------------
function calcBuyCost(weight, goldRate, chargeMode, charges, includeCharges) {
  const goldValue = weight * goldRate;
  if (!includeCharges) return goldValue;

  switch (chargeMode) {
    case 'itemized': {
      const luxTax = goldValue * (charges.luxuryTax || 0) / 100;
      return goldValue + (charges.jyaala || 0) + (charges.jarti || 0) + luxTax;
    }
    case 'lumpsum':
      return goldValue + (charges.totalCharges || 0);
    case 'fromtotal':
      return charges.totalPaid || goldValue;
    default:
      return goldValue;
  }
}

// ---------------------------------------------------------------------------
// Alpine.js Component
// ---------------------------------------------------------------------------
document.addEventListener('alpine:init', () => {
  Alpine.data('goldTracker', () => ({

    // -----------------------------------------------------------------------
    // Tab state
    // -----------------------------------------------------------------------
    activeTab: 'quick',

    // -----------------------------------------------------------------------
    // Quick Calculator state
    // -----------------------------------------------------------------------
    quickWeight: 1,
    quickBuyRate: 0,
    quickSellRate: 0,
    quickChargeMode: 'itemized',
    quickJyaala: 0,
    quickJarti: 0,
    quickLuxuryTax: 0,
    quickTotalCharges: 0,
    quickTotalPaid: 0,
    includeCharges: true,
    includeSellerMargin: true,
    quickCustomProfit: '',
    quickCustomLoss: '',

    // -----------------------------------------------------------------------
    // Quick Calculator computed getters
    // -----------------------------------------------------------------------
    get quickBuyCost() {
      const w = parseFloat(this.quickWeight) || 0;
      const r = parseFloat(this.quickBuyRate) || 0;
      return calcBuyCost(w, r, this.quickChargeMode, {
        jyaala: parseFloat(this.quickJyaala) || 0,
        jarti: parseFloat(this.quickJarti) || 0,
        luxuryTax: parseFloat(this.quickLuxuryTax) || 0,
        totalCharges: parseFloat(this.quickTotalCharges) || 0,
        totalPaid: parseFloat(this.quickTotalPaid) || 0,
      }, this.includeCharges);
    },

    get quickGoldValue() {
      return (parseFloat(this.quickWeight) || 0) * (parseFloat(this.quickBuyRate) || 0);
    },

    get quickChargesBreakdown() {
      const w = parseFloat(this.quickWeight) || 0;
      const r = parseFloat(this.quickBuyRate) || 0;
      const goldValue = w * r;
      const jyaala = parseFloat(this.quickJyaala) || 0;
      const jarti = parseFloat(this.quickJarti) || 0;
      const luxPct = parseFloat(this.quickLuxuryTax) || 0;
      const luxAmt = goldValue * luxPct / 100;

      if (this.quickChargeMode === 'itemized') {
        return { jyaala, jarti, luxuryTaxAmt: luxAmt, total: jyaala + jarti + luxAmt };
      }
      if (this.quickChargeMode === 'lumpsum') {
        const tc = parseFloat(this.quickTotalCharges) || 0;
        return { jyaala: 0, jarti: 0, luxuryTaxAmt: 0, total: tc };
      }
      // fromtotal
      const tp = parseFloat(this.quickTotalPaid) || 0;
      const derived = tp - goldValue;
      return { jyaala: 0, jarti: 0, luxuryTaxAmt: 0, total: derived > 0 ? derived : 0 };
    },

    get quickSellGross() {
      return (parseFloat(this.quickWeight) || 0) * (parseFloat(this.quickSellRate) || 0);
    },

    get quickSellerCut() {
      return this.includeSellerMargin ? this.quickSellGross * SELLER_MARGIN : 0;
    },

    get quickSellNet() {
      return this.quickSellGross - this.quickSellerCut;
    },

    get quickPL() {
      return this.quickSellNet - this.quickBuyCost;
    },

    get quickPLPercent() {
      if (!this.quickBuyCost) return 0;
      return (this.quickPL / this.quickBuyCost) * 100;
    },

    get quickBreakeven() {
      const w = parseFloat(this.quickWeight) || 0;
      if (!w || !this.quickBuyCost) return 0;
      return this.includeSellerMargin
        ? this.quickBuyCost / (w * (1 - SELLER_MARGIN))
        : this.quickBuyCost / w;
    },

    get quickCashInHand() {
      return this.quickSellNet;
    },

    get quickProfitRows() {
      const rows = [];
      const w = parseFloat(this.quickWeight) || 0;
      const cost = this.quickBuyCost;
      if (!w || !cost) return rows;

      const margins = [...PROFIT_MARGINS];
      const custom = parseFloat(this.quickCustomProfit);
      if (custom > 0 && !margins.includes(custom)) margins.push(custom);
      margins.sort((a, b) => a - b);

      const factor = this.includeSellerMargin ? (1 - SELLER_MARGIN) : 1;

      for (const m of margins) {
        const targetRate = (cost * (1 + m / 100)) / (w * factor);
        const netAmount = targetRate * w * factor;
        const plAmount = netAmount - cost;
        rows.push({
          margin: m,
          targetRate,
          netAmount,
          plAmount,
          isCustom: custom > 0 && m === custom && !PROFIT_MARGINS.includes(m),
        });
      }
      return rows;
    },

    get quickLossRows() {
      const rows = [];
      const w = parseFloat(this.quickWeight) || 0;
      const cost = this.quickBuyCost;
      if (!w || !cost) return rows;

      const margins = [...LOSS_MARGINS];
      const custom = parseFloat(this.quickCustomLoss);
      if (custom > 0 && !margins.includes(custom)) margins.push(custom);
      margins.sort((a, b) => a - b);

      const factor = this.includeSellerMargin ? (1 - SELLER_MARGIN) : 1;

      for (const m of margins) {
        const targetRate = (cost * (1 - m / 100)) / (w * factor);
        const netAmount = targetRate * w * factor;
        const plAmount = netAmount - cost;
        rows.push({
          margin: m,
          targetRate,
          netAmount,
          plAmount,
          isCustom: custom > 0 && m === custom && !LOSS_MARGINS.includes(m),
        });
      }
      return rows;
    },

    // -----------------------------------------------------------------------
    // Portfolio state
    // -----------------------------------------------------------------------
    holdings: [],
    soldTransactions: [],
    showAddModal: false,
    showSellModal: false,
    showEditModal: false,
    showImportModal: false,
    editingHolding: null,
    sellingHolding: null,
    expandedHolding: null,
    sellWeight: 0,
    sellRate: 0,
    sellDate: todayStr(),
    importText: '',
    sortField: 'label',
    sortDir: 'asc',
    portfolioCustomProfit: '',
    portfolioCustomLoss: '',

    // Form state for add/edit modal
    formLabel: '',
    formWeight: 0,
    formGoldRate: 0,
    formBuyDate: todayStr(),
    formChargeMode: 'itemized',
    formJyaala: 0,
    formJarti: 0,
    formLuxuryTax: 0,
    formTotalCharges: 0,
    formTotalPaid: 0,

    // -----------------------------------------------------------------------
    // Portfolio — buy cost helpers
    // -----------------------------------------------------------------------
    calcHoldingBuyCost(h) {
      return calcBuyCost(h.weight, h.goldRate, h.chargeMode, {
        jyaala: h.jyaala || 0,
        jarti: h.jarti || 0,
        luxuryTax: h.luxuryTax || 0,
        totalCharges: h.totalCharges || 0,
        totalPaid: h.totalPaid || 0,
      }, this.includeCharges);
    },

    calcHoldingBreakeven(h) {
      const cost = this.calcHoldingBuyCost(h);
      if (!h.weight || !cost) return 0;
      return this.includeSellerMargin
        ? cost / (h.weight * (1 - SELLER_MARGIN))
        : cost / h.weight;
    },

    calcHoldingCurrentValue(h) {
      const rate = this.liveNprPerTola;
      if (!rate) return 0;
      const gross = h.weight * rate;
      return this.includeSellerMargin ? gross * (1 - SELLER_MARGIN) : gross;
    },

    calcHoldingPL(h) {
      const currentVal = this.calcHoldingCurrentValue(h);
      if (!currentVal) return null;
      return currentVal - this.calcHoldingBuyCost(h);
    },

    calcHoldingPLPercent(h) {
      const cost = this.calcHoldingBuyCost(h);
      const pl = this.calcHoldingPL(h);
      if (!cost || pl === null) return null;
      return (pl / cost) * 100;
    },

    calcHoldingChargesBreakdown(h) {
      const goldValue = h.weight * h.goldRate;
      if (h.chargeMode === 'itemized') {
        const luxAmt = goldValue * (h.luxuryTax || 0) / 100;
        return {
          jyaala: h.jyaala || 0,
          jarti: h.jarti || 0,
          luxuryTaxAmt: luxAmt,
          total: (h.jyaala || 0) + (h.jarti || 0) + luxAmt,
        };
      }
      if (h.chargeMode === 'lumpsum') {
        return { jyaala: 0, jarti: 0, luxuryTaxAmt: 0, total: h.totalCharges || 0 };
      }
      const derived = (h.totalPaid || 0) - goldValue;
      return { jyaala: 0, jarti: 0, luxuryTaxAmt: 0, total: derived > 0 ? derived : 0 };
    },

    holdingProfitRows(h) {
      const rows = [];
      const cost = this.calcHoldingBuyCost(h);
      if (!h.weight || !cost) return rows;

      const margins = [...PROFIT_MARGINS];
      const custom = parseFloat(this.portfolioCustomProfit);
      if (custom > 0 && !margins.includes(custom)) margins.push(custom);
      margins.sort((a, b) => a - b);

      const factor = this.includeSellerMargin ? (1 - SELLER_MARGIN) : 1;

      for (const m of margins) {
        const targetRate = (cost * (1 + m / 100)) / (h.weight * factor);
        const netAmount = targetRate * h.weight * factor;
        const plAmount = netAmount - cost;
        rows.push({
          margin: m,
          targetRate,
          netAmount,
          plAmount,
          isCustom: custom > 0 && m === custom && !PROFIT_MARGINS.includes(m),
        });
      }
      return rows;
    },

    holdingLossRows(h) {
      const rows = [];
      const cost = this.calcHoldingBuyCost(h);
      if (!h.weight || !cost) return rows;

      const margins = [...LOSS_MARGINS];
      const custom = parseFloat(this.portfolioCustomLoss);
      if (custom > 0 && !margins.includes(custom)) margins.push(custom);
      margins.sort((a, b) => a - b);

      const factor = this.includeSellerMargin ? (1 - SELLER_MARGIN) : 1;

      for (const m of margins) {
        const targetRate = (cost * (1 - m / 100)) / (h.weight * factor);
        const netAmount = targetRate * h.weight * factor;
        const plAmount = netAmount - cost;
        rows.push({
          margin: m,
          targetRate,
          netAmount,
          plAmount,
          isCustom: custom > 0 && m === custom && !LOSS_MARGINS.includes(m),
        });
      }
      return rows;
    },

    // -----------------------------------------------------------------------
    // Portfolio — CRUD
    // -----------------------------------------------------------------------
    openAddModal() {
      this.editingHolding = null;
      this.formLabel = '';
      this.formWeight = 0;
      this.formGoldRate = 0;
      this.formBuyDate = todayStr();
      this.formChargeMode = 'itemized';
      this.formJyaala = 0;
      this.formJarti = 0;
      this.formLuxuryTax = 0;
      this.formTotalCharges = 0;
      this.formTotalPaid = 0;
      this.showAddModal = true;
    },

    openEditModal(h) {
      this.editingHolding = h.id;
      this.formLabel = h.label;
      this.formWeight = h.weight;
      this.formGoldRate = h.goldRate;
      this.formBuyDate = h.buyDate;
      this.formChargeMode = h.chargeMode || 'itemized';
      this.formJyaala = h.jyaala || 0;
      this.formJarti = h.jarti || 0;
      this.formLuxuryTax = h.luxuryTax || 0;
      this.formTotalCharges = h.totalCharges || 0;
      this.formTotalPaid = h.totalPaid || 0;
      this.showEditModal = true;
    },

    saveHolding() {
      const holding = {
        id: this.editingHolding || generateId(),
        label: this.formLabel || 'Untitled',
        weight: parseFloat(this.formWeight) || 0,
        goldRate: parseFloat(this.formGoldRate) || 0,
        buyDate: this.formBuyDate || todayStr(),
        chargeMode: this.formChargeMode,
        jyaala: parseFloat(this.formJyaala) || 0,
        jarti: parseFloat(this.formJarti) || 0,
        luxuryTax: parseFloat(this.formLuxuryTax) || 0,
        totalCharges: parseFloat(this.formTotalCharges) || 0,
        totalPaid: parseFloat(this.formTotalPaid) || 0,
      };

      if (this.editingHolding) {
        const idx = this.holdings.findIndex(h => h.id === this.editingHolding);
        if (idx !== -1) this.holdings[idx] = holding;
      } else {
        this.holdings.push(holding);
      }

      this.persistHoldings();
      this.showAddModal = false;
      this.showEditModal = false;
      this.editingHolding = null;
    },

    deleteHolding(id) {
      if (!confirm('Delete this holding? This cannot be undone.')) return;
      this.holdings = this.holdings.filter(h => h.id !== id);
      if (this.expandedHolding === id) this.expandedHolding = null;
      this.persistHoldings();
    },

    openSellModal(h) {
      this.sellingHolding = h;
      this.sellWeight = h.weight;
      this.sellRate = this.liveNprPerTola ? Math.round(this.liveNprPerTola) : 0;
      this.sellDate = todayStr();
      this.showSellModal = true;
    },

    confirmSell() {
      const h = this.sellingHolding;
      if (!h) return;

      const sw = parseFloat(this.sellWeight) || 0;
      const sr = parseFloat(this.sellRate) || 0;
      if (sw <= 0 || sr <= 0) return;

      const sellWeightClamped = Math.min(sw, h.weight);
      const costPerTola = this.calcHoldingBuyCost(h) / h.weight;
      const sellBuyCost = costPerTola * sellWeightClamped;

      const gross = sellWeightClamped * sr;
      const sellerCut = this.includeSellerMargin ? gross * SELLER_MARGIN : 0;
      const netReceived = gross - sellerCut;
      const pl = netReceived - sellBuyCost;

      const sold = {
        id: generateId(),
        label: h.label,
        weight: sellWeightClamped,
        goldRate: h.goldRate,
        buyDate: h.buyDate,
        sellRate: sr,
        sellDate: this.sellDate,
        chargeMode: h.chargeMode,
        jyaala: h.jyaala ? (h.jyaala / h.weight) * sellWeightClamped : 0,
        jarti: h.jarti ? (h.jarti / h.weight) * sellWeightClamped : 0,
        luxuryTax: h.luxuryTax || 0,
        totalCharges: h.totalCharges ? (h.totalCharges / h.weight) * sellWeightClamped : 0,
        totalPaid: h.totalPaid ? (h.totalPaid / h.weight) * sellWeightClamped : 0,
        holdingDays: daysBetween(h.buyDate, this.sellDate),
        pl,
        netReceived,
      };

      this.soldTransactions.push(sold);

      // Partial or full sell
      const remaining = h.weight - sellWeightClamped;
      if (remaining > 0.001) {
        const idx = this.holdings.findIndex(x => x.id === h.id);
        if (idx !== -1) {
          // Proportionally reduce charges for partial sell
          const ratio = remaining / h.weight;
          this.holdings[idx] = {
            ...h,
            weight: remaining,
            jyaala: h.jyaala ? h.jyaala * ratio : 0,
            jarti: h.jarti ? h.jarti * ratio : 0,
            totalCharges: h.totalCharges ? h.totalCharges * ratio : 0,
            totalPaid: h.totalPaid ? h.totalPaid * ratio : 0,
          };
        }
      } else {
        this.holdings = this.holdings.filter(x => x.id !== h.id);
        if (this.expandedHolding === h.id) this.expandedHolding = null;
      }

      this.persistHoldings();
      this.persistSold();
      this.showSellModal = false;
      this.sellingHolding = null;
    },

    deleteSold(id) {
      if (!confirm('Delete this sold transaction?')) return;
      this.soldTransactions = this.soldTransactions.filter(s => s.id !== id);
      this.persistSold();
    },

    toggleExpanded(id) {
      this.expandedHolding = this.expandedHolding === id ? null : id;
    },

    // -----------------------------------------------------------------------
    // Portfolio — sorting
    // -----------------------------------------------------------------------
    toggleSort(field) {
      if (this.sortField === field) {
        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        this.sortField = field;
        this.sortDir = 'asc';
      }
    },

    get sortedHoldings() {
      const arr = [...this.holdings];
      const dir = this.sortDir === 'asc' ? 1 : -1;
      const field = this.sortField;

      return arr.sort((a, b) => {
        let va, vb;
        switch (field) {
          case 'label':
            va = (a.label || '').toLowerCase();
            vb = (b.label || '').toLowerCase();
            return va < vb ? -dir : va > vb ? dir : 0;
          case 'weight':
            return (a.weight - b.weight) * dir;
          case 'goldRate':
            return (a.goldRate - b.goldRate) * dir;
          case 'buyDate':
            return (new Date(a.buyDate) - new Date(b.buyDate)) * dir;
          case 'invested':
            return (this.calcHoldingBuyCost(a) - this.calcHoldingBuyCost(b)) * dir;
          case 'pl': {
            const pla = this.calcHoldingPL(a) || 0;
            const plb = this.calcHoldingPL(b) || 0;
            return (pla - plb) * dir;
          }
          default:
            return 0;
        }
      });
    },

    // -----------------------------------------------------------------------
    // Portfolio — consolidated totals
    // -----------------------------------------------------------------------
    get consolidatedTotals() {
      let totalWeight = 0;
      let totalInvested = 0;
      let totalCurrentValue = 0;

      for (const h of this.holdings) {
        totalWeight += h.weight;
        totalInvested += this.calcHoldingBuyCost(h);
        totalCurrentValue += this.calcHoldingCurrentValue(h);
      }

      const totalPL = totalCurrentValue ? totalCurrentValue - totalInvested : null;
      const totalPLPercent = totalInvested && totalPL !== null
        ? (totalPL / totalInvested) * 100 : null;

      const avgRate = totalWeight ? totalInvested / totalWeight : 0;

      return {
        totalWeight,
        totalInvested,
        totalCurrentValue,
        totalPL,
        totalPLPercent,
        avgRate,
      };
    },

    // -----------------------------------------------------------------------
    // Portfolio — realized P/L
    // -----------------------------------------------------------------------
    get totalProfit() {
      return this.soldTransactions
        .filter(s => s.pl > 0)
        .reduce((sum, s) => sum + s.pl, 0);
    },

    get totalLoss() {
      return this.soldTransactions
        .filter(s => s.pl < 0)
        .reduce((sum, s) => sum + s.pl, 0);
    },

    get netRealizedPL() {
      return this.soldTransactions.reduce((sum, s) => sum + s.pl, 0);
    },

    // -----------------------------------------------------------------------
    // Portfolio — export/import
    // -----------------------------------------------------------------------
    exportPortfolio() {
      const data = {
        holdings: this.holdings,
        soldTransactions: this.soldTransactions,
        exportedAt: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gold-portfolio-${todayStr()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },

    importPortfolio() {
      if (!this.importText.trim()) return;
      try {
        const data = JSON.parse(this.importText);
        if (!data.holdings || !Array.isArray(data.holdings)) {
          alert('Invalid format: missing holdings array.');
          return;
        }
        if (!confirm('This will overwrite your current portfolio. Continue?')) return;

        this.holdings = data.holdings;
        this.soldTransactions = data.soldTransactions || [];
        this.persistHoldings();
        this.persistSold();
        this.showImportModal = false;
        this.importText = '';
      } catch (e) {
        alert('Invalid JSON: ' + e.message);
      }
    },

    // -----------------------------------------------------------------------
    // Portfolio — persistence
    // -----------------------------------------------------------------------
    persistHoldings() {
      saveJSON('gold_holdings', this.holdings);
    },

    persistSold() {
      saveJSON('gold_sold', this.soldTransactions);
    },

    persistToggles() {
      saveJSON('gold_toggles', {
        includeCharges: this.includeCharges,
        includeSellerMargin: this.includeSellerMargin,
      });
    },

    loadToggles() {
      const t = loadJSON('gold_toggles', null);
      if (t) {
        this.includeCharges = t.includeCharges !== false;
        this.includeSellerMargin = t.includeSellerMargin !== false;
      }
    },

    // -----------------------------------------------------------------------
    // Live Market state
    // -----------------------------------------------------------------------
    marketData: null,
    marketMargin: DEFAULT_MARKET_MARGIN * 100,
    converterWeight: 1,
    converterAmount: 0,
    isLoadingMarket: false,
    marketError: null,
    chartInstance: null,
    chartPeriod: '1M',

    // -----------------------------------------------------------------------
    // Live Market — computed
    // -----------------------------------------------------------------------
    get liveNprPerTola() {
      if (!this.marketData) return 0;
      const { xauUsd, usdNpr } = this.marketData;
      if (!xauUsd || !usdNpr) return 0;
      const margin = (parseFloat(this.marketMargin) || 1.3) / 100;
      const perTolaUsd = (xauUsd * GRAMS_PER_TOLA) / GRAMS_PER_TROY_OZ;
      const perTolaNpr = perTolaUsd * usdNpr;
      const afterDuty = perTolaNpr * (1 + CUSTOMS_DUTY);
      return afterDuty * (1 + margin);
    },

    get liveXauUsd() {
      return this.marketData?.xauUsd || 0;
    },

    get liveUsdNpr() {
      return this.marketData?.usdNpr || 0;
    },

    get converterValue() {
      const w = parseFloat(this.converterWeight) || 0;
      return w * this.liveNprPerTola;
    },

    get converterTola() {
      const amt = parseFloat(this.converterAmount) || 0;
      if (!this.liveNprPerTola) return 0;
      return amt / this.liveNprPerTola;
    },

    get isMarketOpen() {
      // Gold trades 24/5: Sunday 5pm ET (22:00 UTC) to Friday 5pm ET (22:00 UTC)
      const now = new Date();
      const utcDay = now.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
      const utcHour = now.getUTCHours();

      // Closed: Friday 22:00 UTC through Sunday 22:00 UTC
      if (utcDay === 6) return false; // Saturday — closed
      if (utcDay === 0 && utcHour < 22) return false; // Sunday before 22:00 UTC — closed
      if (utcDay === 5 && utcHour >= 22) return false; // Friday after 22:00 UTC — closed
      return true;
    },

    get marketStatusText() {
      return this.isMarketOpen ? 'Market Open' : 'Market Closed';
    },

    get marketDataAge() {
      if (!this.marketData?.timestamp) return null;
      const mins = Math.round((Date.now() - this.marketData.timestamp) / 60000);
      if (mins < 1) return 'Just now';
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      return `${hrs}h ${mins % 60}m ago`;
    },

    // -----------------------------------------------------------------------
    // Live Market — data fetching
    // -----------------------------------------------------------------------
    isMarketDataStale() {
      if (!this.marketData?.timestamp) return true;
      return Date.now() - this.marketData.timestamp > 30 * 60 * 1000; // 30 min
    },

    async fetchMarketData() {
      if (this.isLoadingMarket) return;
      this.isLoadingMarket = true;
      this.marketError = null;

      try {
        if (window.GoldAPI && typeof window.GoldAPI.fetchLiveData === 'function') {
          const data = await window.GoldAPI.fetchLiveData();
          this.marketData = {
            ...data,
            timestamp: Date.now(),
          };
        } else {
          // Inline fetch if GoldAPI module not loaded yet
          const [goldRes, fxRes] = await Promise.all([
            fetch('https://api.gold-api.com/spot/quote/XAU/USD').then(r => r.json()),
            fetch('https://api.frankfurter.dev/v2/rate/USD/NPR').then(r => r.json()),
          ]);

          const xauUsd = goldRes.price || goldRes.spot_price || 0;
          const usdNpr = fxRes.data?.NPR?.value || fxRes.rates?.NPR || 0;

          const margin = (parseFloat(this.marketMargin) || 1.3) / 100;
          const perTolaUsd = (xauUsd * GRAMS_PER_TOLA) / GRAMS_PER_TROY_OZ;
          const perTolaNpr = perTolaUsd * usdNpr;
          const afterDuty = perTolaNpr * (1 + CUSTOMS_DUTY);
          const nprPerTola = afterDuty * (1 + margin);

          this.marketData = {
            xauUsd,
            usdNpr,
            nprPerTola,
            timestamp: Date.now(),
          };
        }

        saveJSON('gold_market_data', this.marketData);
        localStorage.setItem('gold_margin', this.marketMargin);
      } catch (e) {
        this.marketError = 'Failed to fetch market data. ' + (e.message || '');
        console.error('Gold market fetch error:', e);
      } finally {
        this.isLoadingMarket = false;
      }
    },

    loadMarketData() {
      this.marketData = loadJSON('gold_market_data', null);
      const savedMargin = localStorage.getItem('gold_margin');
      if (savedMargin) this.marketMargin = parseFloat(savedMargin) || 1.3;
    },

    // -----------------------------------------------------------------------
    // Live Market — chart
    // -----------------------------------------------------------------------
    async loadChart() {
      if (!window.Chart) {
        console.warn('Chart.js not loaded');
        return;
      }

      const canvas = document.getElementById('goldChart');
      if (!canvas) return;

      const periodMap = {
        '1W': 7,
        '1M': 30,
        '3M': 90,
        '6M': 180,
        '1Y': 365,
      };
      const days = periodMap[this.chartPeriod] || 30;

      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const fromStr = startDate.toISOString().split('T')[0];
      const toStr = endDate.toISOString().split('T')[0];

      try {
        const [goldRes, fxRes] = await Promise.all([
          fetch(`https://api.gold-api.com/spot/ohlc/XAU/USD?period=${this.chartPeriod}`)
            .then(r => r.json())
            .catch(() => null),
          fetch(`https://api.frankfurter.dev/v2/rate/USD/NPR?from=${fromStr}&to=${toStr}`)
            .then(r => r.json())
            .catch(() => null),
        ]);

        // Build exchange rate lookup by date
        const fxByDate = {};
        let lastKnownFx = this.marketData?.usdNpr || 135;

        if (fxRes && fxRes.data) {
          // Frankfurter v2 returns { data: { "YYYY-MM-DD": { NPR: { value: N } } } }
          for (const [date, rates] of Object.entries(fxRes.data)) {
            const val = rates?.NPR?.value || rates?.NPR;
            if (val) {
              fxByDate[date] = val;
              lastKnownFx = val;
            }
          }
        } else if (fxRes && fxRes.rates) {
          // Fallback for other response shapes
          for (const [date, rates] of Object.entries(fxRes.rates)) {
            if (rates?.NPR) {
              fxByDate[date] = rates.NPR;
              lastKnownFx = rates.NPR;
            }
          }
        }

        // Build chart data from gold OHLC
        const labels = [];
        const values = [];
        const margin = (parseFloat(this.marketMargin) || 1.3) / 100;

        if (goldRes && Array.isArray(goldRes)) {
          // Sort by date
          const sorted = goldRes.sort((a, b) => new Date(a.date || a.t) - new Date(b.date || b.t));

          for (const candle of sorted) {
            const date = (candle.date || candle.t || '').split('T')[0];
            const close = candle.close || candle.c || 0;
            if (!date || !close) continue;

            const fx = fxByDate[date] || lastKnownFx;
            const perTolaUsd = (close * GRAMS_PER_TOLA) / GRAMS_PER_TROY_OZ;
            const perTolaNpr = perTolaUsd * fx;
            const afterDuty = perTolaNpr * (1 + CUSTOMS_DUTY);
            const finalPrice = afterDuty * (1 + margin);

            labels.push(date);
            values.push(Math.round(finalPrice));
          }
        }

        // If no OHLC data, show a message
        if (labels.length === 0) {
          if (this.chartInstance) {
            this.chartInstance.destroy();
            this.chartInstance = null;
          }
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#6b7280';
          ctx.font = '14px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('No historical data available', canvas.width / 2, canvas.height / 2);
          return;
        }

        // Destroy previous chart instance
        if (this.chartInstance) {
          this.chartInstance.destroy();
        }

        const ctx = canvas.getContext('2d');
        this.chartInstance = new Chart(ctx, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'NPR / Tola',
              data: values,
              borderColor: '#6366f1',
              backgroundColor: 'rgba(99, 102, 241, 0.1)',
              borderWidth: 2,
              fill: true,
              tension: 0.3,
              pointRadius: labels.length > 60 ? 0 : 3,
              pointHoverRadius: 5,
              pointBackgroundColor: '#6366f1',
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
              mode: 'index',
              intersect: false,
            },
            plugins: {
              legend: {
                display: false,
              },
              tooltip: {
                backgroundColor: '#1a1d27',
                borderColor: '#2a2d3a',
                borderWidth: 1,
                titleColor: '#e5e7eb',
                bodyColor: '#9ca3af',
                padding: 12,
                displayColors: false,
                callbacks: {
                  title: (items) => items[0]?.label || '',
                  label: (item) => `NPR ${fmt(item.raw)} / tola`,
                },
              },
            },
            scales: {
              x: {
                grid: { color: 'rgba(42, 45, 58, 0.5)' },
                ticks: {
                  color: '#6b7280',
                  maxTicksLimit: 8,
                  font: { family: 'Inter', size: 11 },
                },
              },
              y: {
                grid: { color: 'rgba(42, 45, 58, 0.5)' },
                ticks: {
                  color: '#6b7280',
                  font: { family: 'Inter', size: 11 },
                  callback: (v) => 'NPR ' + (v / 1000).toFixed(0) + 'K',
                },
              },
            },
          },
        });
      } catch (e) {
        console.error('Chart load error:', e);
      }
    },

    refreshChart() {
      this.loadChart();
    },

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------
    init() {
      // Load persisted data
      this.holdings = loadJSON('gold_holdings', []);
      this.soldTransactions = loadJSON('gold_sold', []);
      this.loadToggles();
      this.loadMarketData();

      // Load persisted tab
      this.activeTab = localStorage.getItem('gold_activeTab') || 'quick';

      // Watch tab changes — persist and load chart when market tab shown
      this.$watch('activeTab', (v) => {
        localStorage.setItem('gold_activeTab', v);
        if (v === 'market') {
          this.$nextTick(() => this.loadChart());
        }
      });

      // Watch toggle changes
      this.$watch('includeCharges', () => this.persistToggles());
      this.$watch('includeSellerMargin', () => this.persistToggles());

      // Watch margin changes — save and recalculate
      this.$watch('marketMargin', (v) => {
        localStorage.setItem('gold_margin', v);
      });

      // Watch chart period changes
      this.$watch('chartPeriod', () => {
        if (this.activeTab === 'market') {
          this.loadChart();
        }
      });

      // Auto-fetch if stale
      if (this.isMarketDataStale()) {
        this.fetchMarketData();
      }

      // Auto-fill sell rate from live data
      this.$watch('marketData', () => {
        if (this.marketData?.nprPerTola && !this.quickSellRate) {
          this.quickSellRate = Math.round(this.marketData.nprPerTola);
        }
        // Also update the dynamically computed nprPerTola
        if (this.liveNprPerTola && !this.quickSellRate) {
          this.quickSellRate = Math.round(this.liveNprPerTola);
        }
      });

      // Load chart if starting on market tab
      if (this.activeTab === 'market') {
        this.$nextTick(() => this.loadChart());
      }

      // Auto-refresh market data every 30 minutes when open
      setInterval(() => {
        if (this.isMarketOpen && this.isMarketDataStale()) {
          this.fetchMarketData();
        }
      }, 5 * 60 * 1000); // Check every 5 min, fetch only if stale
    },
  }));
});
