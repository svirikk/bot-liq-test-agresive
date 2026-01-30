// ============================================================================
// BINANCE FUTURES AGGRESSIVE FLOW MONITOR (Enhanced Version)
// Individual symbol filters + Trading bot integration ready
// + RUNTIME CONFIGURATION VIA TELEGRAM
// ============================================================================

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ============================================================================
// BASE CONFIGURATION (Initial values - can be changed via Telegram)
// ============================================================================

const CONFIG = {
  // Individual symbol configurations
  SYMBOL_CONFIGS: {
    'ADAUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.6,
      cooldownMinutes: 5,
      enabled: true
    },
    'TAOUSDT': {
      minVolumeUSD: 1_500_000,
      minDominance: 65.0,
      minPriceChange: 0.6,
      cooldownMinutes: 5,
      enabled: true
    },
    'HYPEUSDT': {
      minVolumeUSD: 5_000_000,
      minDominance: 70.0,
      minPriceChange: 0.8,
      cooldownMinutes: 5,
      enabled: true
    },
    'PEPEUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.6,
      cooldownMinutes: 5,
      enabled: true
    },
    'WIFUSDT': {
      minVolumeUSD: 1_500_000,
      minDominance: 65.0,
      minPriceChange: 0.5,
      cooldownMinutes: 5,
      enabled: true
    },
    'BONKUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.5,
      cooldownMinutes: 5,
      enabled: true
    },
    'DOGEUSDT': {
      minVolumeUSD: 5_000_000,
      minDominance: 70.0,
      minPriceChange: 0.75,
      cooldownMinutes: 5,
      enabled: true
    },
    'XRPUSDT': {
      minVolumeUSD: 5_000_000,
      minDominance: 70.0,
      minPriceChange: 1,
      cooldownMinutes: 5,
      enabled: true
    },
    'UNIUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.5,
      cooldownMinutes: 5,
      enabled: true
    }
  },
  
  // Time window for aggregation
  WINDOW_SECONDS: parseInt(process.env.WINDOW_SECONDS) || 180,
  
  // Exhaustion Filter Settings
  EXHAUSTION_AVG_CANDLES: 5,      // N = 5 (для середньої агресії)
  EXHAUSTION_THRESHOLD: 0.5,       // K = 0.5
  EXHAUSTION_MAX_WAIT: 3,          // maxWaitCandles = 3
  
  // System
  STATS_LOG_INTERVAL: parseInt(process.env.STATS_LOG_INTERVAL) || 60,
  MAX_RECONNECTS: parseInt(process.env.MAX_RECONNECTS) || 10,
  
  // Binance WebSocket
  BINANCE_WS: 'wss://fstream.binance.com/ws',
  
  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  
  // Trading bot integration settings
  TRADING_BOT_ENABLED: process.env.TRADING_BOT_ENABLED === 'true' || false,
  ALERT_FORMAT: 'structured' // 'structured' for bot parsing or 'human' for readable
};

// ============================================================================
// RUNTIME CONFIGURATION MANAGER
// Manages symbol settings that can be changed without restart
// ============================================================================

class RuntimeConfig {
  constructor(initialConfig) {
    // Deep clone initial configuration
    this.symbolConfigs = {};
    for (const [symbol, config] of Object.entries(initialConfig)) {
      this.symbolConfigs[symbol] = { ...config };
    }
  }

  // Get config for specific symbol
  get(symbol) {
    return this.symbolConfigs[symbol] || null;
  }

  // Get all enabled symbols
  getEnabledSymbols() {
    return Object.keys(this.symbolConfigs).filter(
      symbol => this.symbolConfigs[symbol].enabled
    );
  }

  // Get all symbols (enabled + disabled)
  getAllSymbols() {
    return Object.keys(this.symbolConfigs);
  }

  // Update a specific parameter for a symbol
  set(symbol, param, value) {
    if (!this.symbolConfigs[symbol]) {
      throw new Error(`Symbol ${symbol} not found`);
    }

    const validParams = ['minVolumeUSD', 'minDominance', 'minPriceChange', 'cooldownMinutes'];
    if (!validParams.includes(param)) {
      throw new Error(`Invalid parameter: ${param}. Valid: ${validParams.join(', ')}`);
    }

    // Validate value type and range
    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      throw new Error(`Invalid value: ${value} (must be a number)`);
    }

    // Range validation
    if (param === 'minVolumeUSD' && numValue < 0) {
      throw new Error('minVolumeUSD must be >= 0');
    }
    if (param === 'minDominance' && (numValue < 50 || numValue > 100)) {
      throw new Error('minDominance must be between 50 and 100');
    }
    if (param === 'minPriceChange' && numValue < 0) {
      throw new Error('minPriceChange must be >= 0');
    }
    if (param === 'cooldownMinutes' && numValue < 0) {
      throw new Error('cooldownMinutes must be >= 0');
    }

    const oldValue = this.symbolConfigs[symbol][param];
    this.symbolConfigs[symbol][param] = numValue;

    console.log(`[CONFIG] ${symbol}.${param}: ${oldValue} → ${numValue}`);
    return { oldValue, newValue: numValue };
  }

  // Enable symbol
  enable(symbol) {
    if (!this.symbolConfigs[symbol]) {
      throw new Error(`Symbol ${symbol} not found`);
    }
    this.symbolConfigs[symbol].enabled = true;
    console.log(`[CONFIG] ${symbol} ENABLED`);
  }

  // Disable symbol
  disable(symbol) {
    if (!this.symbolConfigs[symbol]) {
      throw new Error(`Symbol ${symbol} not found`);
    }
    this.symbolConfigs[symbol].enabled = false;
    console.log(`[CONFIG] ${symbol} DISABLED`);
  }

  // Get formatted config for display
  format(symbol) {
    const config = this.symbolConfigs[symbol];
    if (!config) return null;

    return {
      symbol,
      enabled: config.enabled,
      minVolumeUSD: config.minVolumeUSD,
      minDominance: config.minDominance,
      minPriceChange: config.minPriceChange,
      cooldownMinutes: config.cooldownMinutes
    };
  }
}

// Global runtime config instance
let runtimeConfig = null;

// ============================================================================
// TELEGRAM COMMAND HANDLER
// Handles /config, /set, /enable, /disable commands
// ============================================================================

class TelegramCommandHandler {
  constructor(telegram, chatId, runtimeConfig) {
    this.telegram = telegram;
    this.chatId = chatId;
    this.runtimeConfig = runtimeConfig;
  }

  async start() {
    // Set up command handlers
    this.telegram.onText(/\/config(\s+\w+)?/, (msg, match) => this.handleConfig(msg, match));
    this.telegram.onText(/\/set\s+(\w+)\s+(\w+)\s+(.+)/, (msg, match) => this.handleSet(msg, match));
    this.telegram.onText(/\/enable\s+(\w+)/, (msg, match) => this.handleEnable(msg, match));
    this.telegram.onText(/\/disable\s+(\w+)/, (msg, match) => this.handleDisable(msg, match));
    this.telegram.onText(/\/help/, (msg) => this.handleHelp(msg));

    console.log('[TELEGRAM] Command handler started');
  }

  async handleConfig(msg, match) {
    try {
      const symbol = match[1] ? match[1].trim().toUpperCase() : null;

      if (symbol) {
        // Show config for specific symbol
        const config = this.runtimeConfig.format(symbol);
        if (!config) {
          await this.sendMessage(`❌ Symbol ${symbol} not found`);
          return;
        }

        const status = config.enabled ? '🟢 ENABLED' : '🔴 DISABLED';
        const message = 
          `⚙️ <b>${symbol} Configuration</b>\n\n` +
          `Status: ${status}\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `💰 Min Volume: $${this.formatVolume(config.minVolumeUSD)}\n` +
          `📊 Min Dominance: ${config.minDominance}%\n` +
          `📈 Min Price Change: ${config.minPriceChange}%\n` +
          `⏱ Cooldown: ${config.cooldownMinutes} min\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `Use /set ${symbol} <param> <value> to change`;

        await this.sendMessage(message);
      } else {
        // Show all symbols
        const symbols = this.runtimeConfig.getAllSymbols();
        const lines = ['⚙️ <b>All Symbol Configurations</b>\n'];
        
        symbols.forEach(sym => {
          const config = this.runtimeConfig.format(sym);
          const status = config.enabled ? '🟢' : '🔴';
          lines.push(
            `${status} <b>${sym}</b>: ` +
            `$${this.formatVolume(config.minVolumeUSD)} | ` +
            `${config.minDominance}% | ` +
            `${config.minPriceChange}%`
          );
        });

        lines.push('\nUse /config SYMBOL for details');
        await this.sendMessage(lines.join('\n'));
      }
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleSet(msg, match) {
    try {
      const symbol = match[1].toUpperCase();
      const param = match[2];
      const value = match[3];

      const result = this.runtimeConfig.set(symbol, param, value);
      
      const message = 
        `✅ <b>Configuration Updated</b>\n\n` +
        `Symbol: ${symbol}\n` +
        `Parameter: ${param}\n` +
        `Old Value: ${result.oldValue}\n` +
        `New Value: ${result.newValue}\n\n` +
        `⚡ Applied immediately (no restart needed)`;

      await this.sendMessage(message);
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleEnable(msg, match) {
    try {
      const symbol = match[1].toUpperCase();
      this.runtimeConfig.enable(symbol);
      
      await this.sendMessage(`✅ ${symbol} monitoring <b>ENABLED</b>`);
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleDisable(msg, match) {
    try {
      const symbol = match[1].toUpperCase();
      this.runtimeConfig.disable(symbol);
      
      await this.sendMessage(`⛔ ${symbol} monitoring <b>DISABLED</b>`);
    } catch (error) {
      await this.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  async handleHelp(msg) {
    const message = 
      `🤖 <b>Available Commands</b>\n\n` +
      `<b>View Configuration:</b>\n` +
      `/config - Show all symbols\n` +
      `/config SYMBOL - Show specific symbol\n\n` +
      `<b>Change Settings:</b>\n` +
      `/set SYMBOL param value\n` +
      `  Example: /set ADAUSDT minVolumeUSD 700000\n` +
      `  Example: /set XRPUSDT minDominance 60\n` +
      `  Example: /set SOLUSDT minPriceChange 0.45\n\n` +
      `<b>Enable/Disable:</b>\n` +
      `/enable SYMBOL - Start monitoring\n` +
      `/disable SYMBOL - Stop monitoring\n\n` +
      `<b>Valid Parameters:</b>\n` +
      `• minVolumeUSD - Minimum volume in USD\n` +
      `• minDominance - Min buy/sell dominance %\n` +
      `• minPriceChange - Min price change %\n` +
      `• cooldownMinutes - Cooldown between alerts\n\n` +
      `⚡ All changes apply instantly!`;

    await this.sendMessage(message);
  }

  formatVolume(num) {
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(0) + 'K';
    return num.toFixed(0);
  }

  async sendMessage(text) {
    try {
      await this.telegram.sendMessage(this.chatId, text, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('[TELEGRAM] Send error:', error.message);
    }
  }
}

// ============================================================================
// SYMBOL STATE (unchanged - trading logic preserved)
// ============================================================================

class SymbolState {
  constructor(symbol, windowSeconds) {
    this.symbol = symbol;
    this.windowMs = windowSeconds * 1000;
    this.trades = [];
    this.firstPrice = null;
    this.lastPrice = null;
  }

  addTrade(timestamp, price, quantity, isBuyerMaker) {
    const volume = price * quantity;
    
    const trade = {
      timestamp,
      price,
      buyVol: isBuyerMaker ? 0 : volume,
      sellVol: isBuyerMaker ? volume : 0
    };

    this.trades.push(trade);
    this.lastPrice = price;
    
    if (this.firstPrice === null) {
      this.firstPrice = price;
    }

    this.cleanup(timestamp);
  }

  cleanup(currentTime) {
    const cutoff = currentTime - this.windowMs;
    this.trades = this.trades.filter(t => t.timestamp >= cutoff);

    if (this.trades.length > 0) {
      this.firstPrice = this.trades[0].price;
    } else {
      this.firstPrice = null;
    }
  }

  getStats() {
    if (this.trades.length === 0) return null;

    let buyVolume = 0;
    let sellVolume = 0;

    for (const trade of this.trades) {
      buyVolume += trade.buyVol;
      sellVolume += trade.sellVol;
    }

    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) return null;

    const buyDominance = (buyVolume / totalVolume) * 100;
    const sellDominance = (sellVolume / totalVolume) * 100;
    
    const dominantSide = buyVolume > sellVolume ? 'buy' : 'sell';
    const dominance = Math.max(buyDominance, sellDominance);

    const priceChange = this.firstPrice 
      ? ((this.lastPrice - this.firstPrice) / this.firstPrice) * 100
      : 0;

    const duration = (this.trades[this.trades.length - 1].timestamp - this.trades[0].timestamp) / 1000;

    return {
      buyVolume,
      sellVolume,
      totalVolume,
      dominantSide,
      dominance,
      priceChange,
      duration,
      tradeCount: this.trades.length,
      lastPrice: this.lastPrice
    };
  }

  reset() {
    this.trades = [];
    this.firstPrice = null;
    this.lastPrice = null;
  }
}

// ============================================================================
// TRADE AGGREGATOR (unchanged - trading logic preserved)
// ============================================================================

class TradeAggregator {
  constructor(windowSeconds) {
    this.windowSeconds = windowSeconds;
    this.states = new Map();
  }

  addTrade(symbol, timestamp, price, quantity, isBuyerMaker) {
    if (!this.states.has(symbol)) {
      this.states.set(symbol, new SymbolState(symbol, this.windowSeconds));
    }
    this.states.get(symbol).addTrade(timestamp, price, quantity, isBuyerMaker);
  }

  getStats(symbol) {
    const state = this.states.get(symbol);
    return state ? state.getStats() : null;
  }

  resetSymbol(symbol) {
    const state = this.states.get(symbol);
    if (state) state.reset();
  }

  getActiveCount() {
    return this.states.size;
  }

  getTotalTrades() {
    let total = 0;
    for (const state of this.states.values()) {
      total += state.trades.length;
    }
    return total;
  }
}

// ============================================================================
// SIGNAL ENGINE (uses runtime config - trading logic preserved)
// ============================================================================

class SignalEngine {
  shouldAlert(symbol, stats) {
    if (!stats) return false;
    
    // Use runtime config instead of CONFIG
    const config = runtimeConfig.get(symbol);
    if (!config || !config.enabled) return false;
    
    // Apply individual symbol filters (unchanged logic)
    if (stats.totalVolume < config.minVolumeUSD) return false;
    if (stats.dominance < config.minDominance) return false;
    if (Math.abs(stats.priceChange) < config.minPriceChange) return false;
    
    // Direction alignment (unchanged logic)
    if (stats.dominantSide === 'buy' && stats.priceChange < 0) return false;
    if (stats.dominantSide === 'sell' && stats.priceChange > 0) return false;

    return true;
  }

  interpretSignal(stats) {
    if (stats.dominantSide === 'buy') {
      return {
        type: 'SHORT_SQUEEZE',
        label: 'SHORT SQUEEZE',
        emoji: '🟢',
        direction: 'BUY',
        description: 'Aggressive buying pressure pushing shorts out'
      };
    } else {
      return {
        type: 'LONG_LIQUIDATION',
        label: 'LONG LIQUIDATION',
        emoji: '🔴',
        direction: 'SELL',
        description: 'Aggressive selling pressure liquidating longs'
      };
    }
  }
}

// ============================================================================
// EXHAUSTION TRACKER (новий фільтр для затримки алертів)
// ============================================================================

class ExhaustionTracker {
  constructor() {
    // Зберігає стан очікування для кожного символу
    // { symbol: { pendingStats, waitStartTime, candleCount, aggressionHistory } }
    this.waitingSymbols = new Map();
  }

  // Перевіряє чи символ в режимі очікування exhaustion
  isWaiting(symbol) {
    return this.waitingSymbols.has(symbol);
  }

  // Починає очікування exhaustion після спрацювання базових фільтрів
  startWaiting(symbol, stats) {
    this.waitingSymbols.set(symbol, {
      pendingStats: stats,
      waitStartTime: Date.now(),
      candleCount: 0,
      aggressionHistory: [{
        timestamp: Date.now(),
        aggression: this.calculateAggression(stats),
        priceChange: Math.abs(stats.priceChange)
      }]
    });
    
    console.log(`[EXHAUSTION] ${symbol} entering WAIT_FOR_EXHAUSTION mode`);
  }

  // Оновлює історію агресії для символу що чекає
  updateAggression(symbol, stats) {
    const waiting = this.waitingSymbols.get(symbol);
    if (!waiting) return;

    const currentAggression = this.calculateAggression(stats);
    
    waiting.aggressionHistory.push({
      timestamp: Date.now(),
      aggression: currentAggression,
      priceChange: Math.abs(stats.priceChange)
    });

    // Тримаємо тільки останні N+1 записів
    if (waiting.aggressionHistory.length > CONFIG.EXHAUSTION_AVG_CANDLES + 1) {
      waiting.aggressionHistory.shift();
    }

    waiting.candleCount++;
  }

  // Перевіряє чи exhaustion підтверджений
  checkExhaustion(symbol, stats) {
    const waiting = this.waitingSymbols.get(symbol);
    if (!waiting) return { confirmed: false, reason: 'not_waiting' };

    // Перевірка таймауту
    if (waiting.candleCount >= CONFIG.EXHAUSTION_MAX_WAIT) {
      console.log(`[EXHAUSTION] ${symbol} timeout (${waiting.candleCount} candles)`);
      this.cancelWaiting(symbol);
      return { confirmed: false, reason: 'timeout' };
    }

    const history = waiting.aggressionHistory;
    if (history.length < 3) {
      return { confirmed: false, reason: 'insufficient_data' };
    }

    const currentAggression = this.calculateAggression(stats);

    // 1. Перевірка: поточна агресія < K × середньої агресії
    const avgAggression = this.calculateAvgAggression(history.slice(0, -1));
    const aggressionDecreased = currentAggression < (CONFIG.EXHAUSTION_THRESHOLD * avgAggression);

    // 2. Перевірка: об'єм агресії зменшується мінімум 2 свічки
    const volumeDecreasing = this.isVolumeDecreasing(history);

    // 3. Перевірка: ціна перестає прискорюватись
    const priceSlowing = this.isPriceSlowing(history);

    const exhaustionConfirmed = aggressionDecreased && volumeDecreasing && priceSlowing;

    if (exhaustionConfirmed) {
      console.log(`[EXHAUSTION] ${symbol} CONFIRMED! ` +
        `Aggr: ${currentAggression.toFixed(0)} < ${(CONFIG.EXHAUSTION_THRESHOLD * avgAggression).toFixed(0)} | ` +
        `Vol↓: ${volumeDecreasing} | Price↓: ${priceSlowing}`);
      return { confirmed: true, reason: 'exhaustion_detected' };
    }

    return { 
      confirmed: false, 
      reason: 'waiting',
      details: { aggressionDecreased, volumeDecreasing, priceSlowing }
    };
  }

  // Скасовує очікування для символу
  cancelWaiting(symbol) {
    this.waitingSymbols.delete(symbol);
    console.log(`[EXHAUSTION] ${symbol} cancelled`);
  }

  // Отримує pending stats для символу
  getPendingStats(symbol) {
    const waiting = this.waitingSymbols.get(symbol);
    return waiting ? waiting.pendingStats : null;
  }

  // Розраховує міру агресії (домінуючий об'єм)
  calculateAggression(stats) {
    return stats.dominantSide === 'buy' ? stats.buyVolume : stats.sellVolume;
  }

  // Розраховує середню агресію за N попередніх свічок
  calculateAvgAggression(history) {
    if (history.length === 0) return 0;
    const sum = history.reduce((acc, h) => acc + h.aggression, 0);
    return sum / history.length;
  }

  // Перевіряє чи об'єм зменшується 2+ свічки підряд
  isVolumeDecreasing(history) {
    if (history.length < 3) return false;
    
    const last3 = history.slice(-3);
    return last3[2].aggression < last3[1].aggression && 
           last3[1].aggression < last3[0].aggression;
  }

  // Перевіряє чи ціна перестає прискорюватись
  isPriceSlowing(history) {
    if (history.length < 3) return false;
    
    const last3 = history.slice(-3);
    const delta1 = last3[1].priceChange;
    const delta2 = last3[2].priceChange;
    
    // Дельта зменшується або свічка нейтральна
    return delta2 < delta1 || delta2 < 0.1;
  }

  // Отримує кількість символів що чекають
  getWaitingCount() {
    return this.waitingSymbols.size;
  }
}

// ============================================================================
// COOLDOWN MANAGER (uses runtime config - unchanged logic)
// ============================================================================

class CooldownManager {
  constructor() {
    this.lastAlerts = new Map();
  }

  canAlert(symbol, stats) {
    // Use runtime config
    const config = runtimeConfig.get(symbol);
    if (!config) return false;

    const key = `${symbol}_${stats.dominantSide}`;
    const lastAlert = this.lastAlerts.get(key);
    
    if (!lastAlert) return true;
    
    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    const elapsed = Date.now() - lastAlert;
    
    return elapsed >= cooldownMs;
  }

  recordAlert(symbol, stats) {
    const key = `${symbol}_${stats.dominantSide}`;
    this.lastAlerts.set(key, Date.now());
  }

  getRemainingCooldown(symbol, side) {
    const config = runtimeConfig.get(symbol);
    if (!config) return 0;

    const key = `${symbol}_${side}`;
    const lastAlert = this.lastAlerts.get(key);
    
    if (!lastAlert) return 0;
    
    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    const elapsed = Date.now() - lastAlert;
    const remaining = Math.max(0, cooldownMs - elapsed);
    
    return Math.ceil(remaining / 1000);
  }
}

// ============================================================================
// ALERT MANAGER (uses runtime config - wait logic preserved)
// ============================================================================

class AlertManager {
  constructor(telegram) {
    this.telegram = telegram;
    this.alertCount = 0;
    this.pendingAlerts = new Map();
  }

  async sendAlert(symbol, stats, interpretation) {
    // Check if already pending for this symbol+side
    const key = `${symbol}_${stats.dominantSide}`;
    if (this.pendingAlerts.has(key)) {
      return;
    }

    // Wait until the next minute boundary (unchanged logic - CRITICAL)
    const now = Date.now();
    const nextMinute = Math.ceil(now / 60000) * 60000;
    const delay = nextMinute - now;

    console.log(`[ALERT] ${symbol} ${interpretation.label} - waiting ${(delay/1000).toFixed(1)}s until next minute`);
    
    this.pendingAlerts.set(key, true);

    setTimeout(async () => {
      try {
        const message = CONFIG.ALERT_FORMAT === 'structured'
          ? this.formatStructuredMessage(symbol, stats, interpretation)
          : this.formatHumanMessage(symbol, stats, interpretation);

        await this.telegram.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
        
        this.alertCount++;
        console.log(`[ALERT] ${symbol} sent (${this.alertCount} total)`);
      } catch (error) {
        console.error(`[ALERT] Error:`, error.message);
      } finally {
        this.pendingAlerts.delete(key);
      }
    }, delay);
  }

  formatStructuredMessage(symbol, stats, interpretation) {
    const data = {
      timestamp: Date.now(),
      symbol: symbol,
      signal: interpretation.type,
      direction: interpretation.direction,
      volume: stats.totalVolume,
      dominance: stats.dominance,
      priceChange: stats.priceChange,
      lastPrice: stats.lastPrice,
      duration: stats.duration,
      exhaustion: interpretation.exhaustion || false
    };

    const lines = [];
    lines.push(`${interpretation.emoji} <b>${interpretation.label}</b>`);
    if (interpretation.exhaustion) {
      lines.push(`⚡ <b>EXHAUSTION CONFIRMED</b>`);
    }
    lines.push(`<code>───────────────────</code>`);
    lines.push(`<b>Symbol:</b> <code>${symbol}</code>`);
    lines.push(`<b>Direction:</b> <code>${interpretation.direction}</code>`);
    lines.push(`<b>Volume:</b> $${this.fmt(stats.totalVolume)} in ${stats.duration.toFixed(0)}s`);
    lines.push(`<b>Dominance:</b> ${stats.dominance.toFixed(1)}%`);
    lines.push(`<b>Price Δ:</b> ${stats.priceChange >= 0 ? '+' : ''}${stats.priceChange.toFixed(2)}%`);
    lines.push(`<b>Last Price:</b> $${stats.lastPrice.toFixed(4)}`);
    if (interpretation.exhaustion) {
      lines.push(`<b>Status:</b> Impulse exhausted, reversal likely`);
    }
    lines.push(`<code>───────────────────</code>`);
    
    // Add machine-readable data block
    lines.push(`<code>${JSON.stringify(data)}</code>`);
    
    return lines.join('\n');
  }

  formatHumanMessage(symbol, stats, interpretation) {
    const lines = [];
    
    lines.push(`${interpretation.emoji} ${interpretation.label}`);
    if (interpretation.exhaustion) {
      lines.push(`⚡ EXHAUSTION - Impulse Fading`);
    }
    lines.push(`💰 Volume: $${this.fmt(stats.totalVolume)} in ${stats.duration.toFixed(0)}s`);
    lines.push(`📊 Dominance: ${stats.dominance.toFixed(1)}% ${interpretation.direction}`);
    lines.push('━━━━━━━━━━━━━━━━━');
    
    const cleanSymbol = symbol.replace('USDT', '');
    lines.push(`🎯 ${symbol} #${cleanSymbol}`);
    
    const priceSign = stats.priceChange >= 0 ? '+' : '';
    lines.push(`📈 Price Δ: ${priceSign}${stats.priceChange.toFixed(2)}%`);
    lines.push(`💵 Last: $${stats.lastPrice.toFixed(4)}`);
    
    if (interpretation.exhaustion) {
      lines.push(`🎯 Entry: Pressure exhausted, better R:R`);
    }
    
    lines.push('━━━━━━━━━━━━━━━━━');
    lines.push(`🟢 Aggressive Buy: $${this.fmt(stats.buyVolume)}`);
    lines.push(`🔴 Aggressive Sell: $${this.fmt(stats.sellVolume)}`);
    
    return lines.join('\n');
  }

  fmt(num) {
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(0) + 'K';
    return num.toFixed(0);
  }

  getCount() {
    return this.alertCount;
  }

  getPendingCount() {
    return this.pendingAlerts.size;
  }
}

// ============================================================================
// MULTI-WEBSOCKET MANAGER (uses runtime config - unchanged logic)
// ============================================================================

class MultiWebSocketManager {
  constructor(symbols, tradeAggregator, signalEngine, cooldownManager, alertManager, exhaustionTracker) {
    this.symbols = symbols;
    this.tradeAggregator = tradeAggregator;
    this.signalEngine = signalEngine;
    this.cooldownManager = cooldownManager;
    this.alertManager = alertManager;
    this.exhaustionTracker = exhaustionTracker;
    
    this.connections = new Map();
    this.tradeCount = 0;
    this.lastStatsLog = Date.now();
    this.reconnectAttempts = new Map();
  }

  connectAll() {
    console.log(`[WS] Connecting to ${this.symbols.length} symbols...`);
    
    // Connect with small delays
    this.symbols.forEach((symbol, i) => {
      setTimeout(() => this.connectSymbol(symbol), i * 200);
    });
  }

  connectSymbol(symbol) {
    const streamName = `${symbol.toLowerCase()}@aggTrade`;
    const url = `${CONFIG.BINANCE_WS}/${streamName}`;
    
    const ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[WS] ${symbol} connected`);
      this.reconnectAttempts.set(symbol, 0);
    });

    ws.on('message', (data) => {
      this.handleMessage(symbol, data);
    });

    ws.on('error', (error) => {
      console.error(`[WS] ${symbol} error:`, error.message);
    });

    ws.on('close', () => {
      console.log(`[WS] ${symbol} closed`);
      this.reconnectSymbol(symbol);
    });

    this.connections.set(symbol, ws);
  }

  handleMessage(symbol, data) {
    try {
      const trade = JSON.parse(data);
      
      const price = parseFloat(trade.p);
      const quantity = parseFloat(trade.q);
      const timestamp = trade.T;
      const isBuyerMaker = trade.m;
      
      this.tradeAggregator.addTrade(symbol, timestamp, price, quantity, isBuyerMaker);
      this.tradeCount++;
      
      // Check for signal (uses runtime config)
      const stats = this.tradeAggregator.getStats(symbol);
      const config = runtimeConfig.get(symbol);
      
      if (stats && config && stats.totalVolume >= config.minVolumeUSD * 0.5) {
        
        // Якщо символ вже в режимі очікування exhaustion
        if (this.exhaustionTracker.isWaiting(symbol)) {
          this.exhaustionTracker.updateAggression(symbol, stats);
          
          const exhaustionCheck = this.exhaustionTracker.checkExhaustion(symbol, stats);
          
          if (exhaustionCheck.confirmed) {
            // EXHAUSTION ПІДТВЕРДЖЕНО - надсилаємо алерт
            if (this.cooldownManager.canAlert(symbol, stats)) {
              const pendingStats = this.exhaustionTracker.getPendingStats(symbol);
              const interpretation = this.signalEngine.interpretSignal(pendingStats);
              
              // Додаємо мітку exhaustion в алерт
              interpretation.exhaustion = true;
              
              this.alertManager.sendAlert(symbol, pendingStats, interpretation);
              this.cooldownManager.recordAlert(symbol, stats);
              this.exhaustionTracker.cancelWaiting(symbol);
              this.tradeAggregator.resetSymbol(symbol);
            } else {
              this.exhaustionTracker.cancelWaiting(symbol);
            }
          } else if (exhaustionCheck.reason === 'timeout') {
            // Таймаут - скасовуємо алерт
            this.tradeAggregator.resetSymbol(symbol);
          }
          // Інакше продовжуємо чекати
          
        } else {
          // Базова перевірка фільтрів агресії
          if (this.signalEngine.shouldAlert(symbol, stats)) {
            // Всі базові фільтри OK - переходимо в режим WAIT_FOR_EXHAUSTION
            this.exhaustionTracker.startWaiting(symbol, stats);
          }
        }
      }
      
      this.logStats();
      
    } catch (error) {
      console.error(`[WS] ${symbol} parse error:`, error.message);
    }
  }

  logStats() {
    const now = Date.now();
    if (now - this.lastStatsLog < CONFIG.STATS_LOG_INTERVAL * 1000) {
      return;
    }

    const activeSymbols = this.tradeAggregator.getActiveCount();
    const totalTrades = this.tradeAggregator.getTotalTrades();
    const alerts = this.alertManager.getCount();
    const pendingAlerts = this.alertManager.getPendingCount();
    const waitingExhaustion = this.exhaustionTracker.getWaitingCount();
    const connected = Array.from(this.connections.values()).filter(ws => ws.readyState === WebSocket.OPEN).length;
    
    console.log(`[STATS] Connected: ${connected}/${this.symbols.length} | Active: ${activeSymbols} | Trades: ${totalTrades} | Alerts: ${alerts} | Pending: ${pendingAlerts} | Waiting: ${waitingExhaustion} | Rate: ${(this.tradeCount / CONFIG.STATS_LOG_INTERVAL).toFixed(0)}/s`);
    
    this.tradeCount = 0;
    this.lastStatsLog = now;
  }

  reconnectSymbol(symbol) {
    const attempts = this.reconnectAttempts.get(symbol) || 0;
    
    if (attempts >= CONFIG.MAX_RECONNECTS) {
      console.error(`[WS] ${symbol} max reconnects reached`);
      return;
    }

    this.reconnectAttempts.set(symbol, attempts + 1);
    
    setTimeout(() => {
      console.log(`[WS] ${symbol} reconnecting (${attempts + 1}/${CONFIG.MAX_RECONNECTS})...`);
      this.connectSymbol(symbol);
    }, 5000 * (attempts + 1));
  }

  closeAll() {
    for (const ws of this.connections.values()) {
      ws.close();
    }
    this.connections.clear();
  }
}

// ============================================================================
// MAIN APPLICATION (with Telegram command handler integration)
// ============================================================================

class BinanceFuturesFlowBot {
  constructor() {
    // Initialize runtime config from base config
    runtimeConfig = new RuntimeConfig(CONFIG.SYMBOL_CONFIGS);
    
    // Enable polling for Telegram commands
    this.telegram = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });
    this.tradeAggregator = new TradeAggregator(CONFIG.WINDOW_SECONDS);
    this.signalEngine = new SignalEngine();
    this.exhaustionTracker = new ExhaustionTracker();
    this.cooldownManager = new CooldownManager();
    this.alertManager = new AlertManager(this.telegram);
    this.wsManager = null;
    this.commandHandler = null;
  }

  async start() {
    // Get enabled symbols from runtime config
    const symbols = runtimeConfig.getEnabledSymbols();
    
    console.log('='.repeat(70));
    console.log('BINANCE FUTURES AGGRESSIVE FLOW MONITOR (Enhanced)');
    console.log('+ RUNTIME CONFIGURATION VIA TELEGRAM');
    console.log('+ EXHAUSTION FILTER ENABLED');
    console.log('='.repeat(70));
    console.log(`Symbols: ${symbols.length} | Window: ${CONFIG.WINDOW_SECONDS}s`);
    console.log(`Exhaustion Filter: N=${CONFIG.EXHAUSTION_AVG_CANDLES} | K=${CONFIG.EXHAUSTION_THRESHOLD} | Max Wait=${CONFIG.EXHAUSTION_MAX_WAIT} candles`);
    console.log('Individual Symbol Settings:');
    
    symbols.forEach(symbol => {
      const config = runtimeConfig.get(symbol);
      console.log(`  ${symbol}: Vol=$${(config.minVolumeUSD / 1e6).toFixed(1)}M | Dom=${config.minDominance}% | Δ=${config.minPriceChange}%`);
    });
    
    console.log('='.repeat(70));
    console.log(`Alert Format: ${CONFIG.ALERT_FORMAT}`);
    console.log(`Trading Bot Integration: ${CONFIG.TRADING_BOT_ENABLED ? 'Enabled' : 'Disabled'}`);
    console.log('='.repeat(70));

    // Start Telegram command handler
    this.commandHandler = new TelegramCommandHandler(
      this.telegram,
      CONFIG.TELEGRAM_CHAT_ID,
      runtimeConfig
    );
    await this.commandHandler.start();

    // Test Telegram
    try {
      const startMessage = symbols.map(s => {
        const c = runtimeConfig.get(s);
        return `• ${s}: $${(c.minVolumeUSD / 1e6).toFixed(1)}M | ${c.minDominance}% | ${c.minPriceChange}%`;
      }).join('\n');
      
      await this.telegram.sendMessage(
        CONFIG.TELEGRAM_CHAT_ID,
        `🚀 <b>Binance Futures Monitor Started</b>\n\n` +
        `<b>📊 Monitoring ${symbols.length} symbols:</b>\n${startMessage}\n\n` +
        `⚙️ Format: ${CONFIG.ALERT_FORMAT}\n` +
        `🤖 Trading Bot: ${CONFIG.TRADING_BOT_ENABLED ? 'ON' : 'OFF'}\n` +
        `🎯 Exhaustion Filter: ON (N=${CONFIG.EXHAUSTION_AVG_CANDLES}, K=${CONFIG.EXHAUSTION_THRESHOLD})\n\n` +
        `📱 Use /help to see available commands`,
        { parse_mode: 'HTML' }
      );
      console.log('[TELEGRAM] ✅ Connected\n');
    } catch (error) {
      console.error('[TELEGRAM] ❌ Error:', error.message);
      process.exit(1);
    }

    // Connect WebSockets
    this.wsManager = new MultiWebSocketManager(
      symbols,
      this.tradeAggregator,
      this.signalEngine,
      this.cooldownManager,
      this.alertManager,
      this.exhaustionTracker
    );
    
    this.wsManager.connectAll();

    // Graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  async shutdown() {
    console.log('\n[SHUTDOWN] Stopping...');
    
    if (this.wsManager) {
      this.wsManager.closeAll();
    }
    
    await this.telegram.sendMessage(
      CONFIG.TELEGRAM_CHAT_ID,
      '⛔ Binance Futures Monitor Stopped'
    );
    
    this.telegram.stopPolling();
    process.exit(0);
  }
}

// ============================================================================
// STARTUP
// ============================================================================

if (require.main === module) {
  const bot = new BinanceFuturesFlowBot();
  bot.start().catch(error => {
    console.error('[FATAL]', error);
    process.exit(1);
  });
}

module.exports = { BinanceFuturesFlowBot };
