import axios from 'axios';
import { config } from '../config/settings.js';
import starkSigner from './stark-signer.service.js';
import logger from '../utils/logger.js';

/**
 * ExtendedService
 * 
 * Замінює bybit.service.js. Все HTTP взаємодія з Extended.exchange REST API.
 * 
 * Маппинг методів:
 *   Bybit                    → Extended
 *   ─────────────────────────────────────────
 *   connect()                → connect() (ping)
 *   getUSDTBalance()         → getBalance()
 *   getCurrentPrice(sym)     → getCurrentPrice(sym)
 *   getSymbolInfo(sym)       → getMarketInfo(sym)
 *   setLeverage(sym, lev)    → setLeverage(sym, lev)
 *   openMarketOrder(...)  ┐  → createOrderWithTPSL() — один запит,
 *   setTakeProfit(...)    ┤     все три ордера LIMIT GTT, maker 0%
 *   setStopLoss(...)      ┘
 *   getOpenPositions(sym)    → getPositions(sym)
 *   getTradeHistory(sym)     → getTradeHistory(sym)
 */
class ExtendedService {
  constructor() {
    this.baseURL = config.extended.baseURL;
    this.apiKey = config.extended.apiKey;
    this.userAgent = config.extended.userAgent;
    this.isConnected = false;

    // Axios instance з обов'язковими headers
    this.http = axios.create({
      baseURL: this.baseURL,
      headers: {
        'X-Api-Key': this.apiKey,
        'User-Agent': this.userAgent,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
  }

  // ═══════════════════════════════════════════════════════════
  // CONNECTION
  // ═══════════════════════════════════════════════════════════

  /**
   * Перевіряє з'єднання з API (аналог bybitService.connect)
   */
  async connect() {
    try {
      logger.info('[EXTENDED] Connecting to Extended.exchange API...');

      // Використовуємо info/markets як ping — якщо відповідь 200, з'єднано
      const response = await this.http.get('/info/markets');

      if (response.status === 200) {
        this.isConnected = true;
        logger.info(`[EXTENDED] ✅ Connected to Extended.exchange`);
        logger.info(`[EXTENDED] Base URL: ${this.baseURL}`);
        return true;
      } else {
        throw new Error(`Unexpected status: ${response.status}`);
      }
    } catch (error) {
      logger.error(`[EXTENDED] Connection failed: ${error.message}`);
      this.isConnected = false;
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // BALANCE
  // ═══════════════════════════════════════════════════════════

  /**
   * Отримує баланс колатерала (USDC на Extended)
   * Аналог: bybitService.getUSDTBalance()
   */
  async getBalance() {
    try {
      const response = await this.http.get('/user/balance');

      if (response.status !== 200) {
        throw new Error(`Failed to get balance: HTTP ${response.status}`);
      }

      const data = response.data;
      
      // --- ДОДАНО ДЛЯ ПЕРЕВІРКИ ---
      logger.info(`🐛 RAW BALANCE JSON: ${JSON.stringify(data)}`);
      // ----------------------------

      // Спробуйте знайти USDC, якщо структура інша
      let available = 0;
      
      // Варіант 1: Простий об'єкт
      if (data.available) available = parseFloat(data.available);
      
      // Варіант 2: Масив активів (часто буває на Starknet)
      else if (Array.isArray(data)) {
         const usdc = data.find(a => a.currency === 'USDC' || a.asset === 'USDC');
         if (usdc) available = parseFloat(usdc.availableBalance || usdc.balance);
      }

      logger.info(`[EXTENDED] Balance parsed: ${available}`);
      return available;
    } catch (error) {
      logger.error(`[EXTENDED] Error getting balance: ${error.message}`);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // MARKET DATA
  // ═══════════════════════════════════════════════════════════

  /**
   * Отримує поточну ціну та order book top для символу
   * Аналог: bybitService.getCurrentPrice()
   * 
   * Повертає { lastPrice, bestBid, bestAsk }
   */
  async getCurrentPrice(symbol) {
    try {
      const response = await this.http.get(`/info/markets/${symbol}/stats`);

      if (response.status !== 200) {
        throw new Error(`Failed to get price: HTTP ${response.status}`);
      }

      const data = response.data;
      const lastPrice = parseFloat(data.lastPrice || data.price || '0');
      const bestBid = parseFloat(data.bestBid || data.bid || lastPrice * 0.9999);
      const bestAsk = parseFloat(data.bestAsk || data.ask || lastPrice * 1.0001);

      logger.info(`[EXTENDED] ${symbol} — Last: ${lastPrice}, Bid: ${bestBid}, Ask: ${bestAsk}`);

      return { lastPrice, bestBid, bestAsk };
    } catch (error) {
      logger.error(`[EXTENDED] Error getting price for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Отримує інформацію про market (tickSize, minQty, maxQty, maxLeverage)
   * Аналог: bybitService.getSymbolInfo()
   */
  async getMarketInfo(symbol) {
    try {
      const response = await this.http.get('/info/markets', {
        params: { market: symbol }
      });

      if (response.status !== 200) {
        throw new Error(`Failed to get market info: HTTP ${response.status}`);
      }

      // Ищем наш market в списке
      const markets = Array.isArray(response.data) ? response.data : [response.data];
      const market = markets.find(m => m.market === symbol || m.name === symbol);

      if (!market) {
        throw new Error(`Market ${symbol} not found`);
      }

      const tc = market.tradingConfig || {};

      return {
        symbol: symbol,
        minOrderSize: parseFloat(tc.minOrderSize || '0.001'),
        minPriceChange: parseFloat(tc.minPriceChange || '0.001'),
        maxLimitOrderValue: parseFloat(tc.maxLimitOrderValue || '5000000'),
        maxPositionValue: parseFloat(tc.maxPositionValue || '10000000'),
        maxLeverage: parseInt(tc.maxLeverage || '50'),
        status: market.status || 'Trading',
        // Для совместимости с risk.service: tickSize = minPriceChange, pricePrecision из minPriceChange
        tickSize: parseFloat(tc.minPriceChange || '0.001'),
        pricePrecision: this._getPrecisionFromStep(parseFloat(tc.minPriceChange || '0.001'))
      };
    } catch (error) {
      logger.error(`[EXTENDED] Error getting market info for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // LEVERAGE
  // ═══════════════════════════════════════════════════════════

  /**
   * Встановлює leverage для market
   * Аналог: bybitService.setLeverage()
   */
  async setLeverage(symbol, leverage) {
    try {
      logger.info(`[EXTENDED] Setting leverage ${leverage}x for ${symbol}...`);

      const response = await this.http.patch('/user/leverage', {
        market: symbol,
        leverage: leverage.toString()
      });

      if (response.status === 200 || response.status === 204) {
        logger.info(`[EXTENDED] ✅ Leverage ${leverage}x set for ${symbol}`);
        return true;
      }

      // Якщо leverage вже встановлено — ОК
      if (response.status === 304) {
        logger.info(`[EXTENDED] ✅ Leverage already ${leverage}x for ${symbol}`);
        return true;
      }

      throw new Error(`Failed to set leverage: HTTP ${response.status}`);
    } catch (error) {
      // 304 / "not modified" = вже встановлено
      if (error.response?.status === 304 ||
          error.message?.includes('not modified') ||
          error.message?.includes('leverage not changed')) {
        logger.info(`[EXTENDED] ✅ Leverage already ${leverage}x for ${symbol}`);
        return true;
      }

      logger.error(`[EXTENDED] Error setting leverage: ${error.message}`);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ORDER CREATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Відкриває позицію з entry + TP + SL за один запит (3 Stark підписи).
   *
   * Всі три ордери — LIMIT GTT.  Fees на всех трёх = maker (0%).
   *
   * Логіка entry цени:
   *   BUY  → price = bestAsk * (1 + entryLimitBuffer)
   *   SELL → price = bestBid * (1 - entryLimitBuffer)
   *
   *   Буфер мінімальний (0.05%) — достатньо щоб ордер опинився на вершині
   *   книги і заполнился одним тиком як maker, без проскальзывания.
   *   Якщо за час між читанням книги і подачею ордера ціна резко стрибнуть —
   *   ордер просто зависне в книці і заполнится по even better цене.
   *
   * @param {Object} params
   * @param {string} params.symbol
   * @param {string} params.side — 'BUY' | 'SELL'
   * @param {string|number} params.quantity
   * @param {number} params.entryPrice — lastPrice (для логів / fallback)
   * @param {{ bestBid: number, bestAsk: number }} params.priceData
   * @param {{ triggerPrice, limitPrice }} params.tp
   * @param {{ triggerPrice, limitPrice }} params.sl
   * @returns {Object} { orderId, entryLimitPrice, ... }
   */
  async createOrderWithTPSL({ symbol, side, quantity, entryPrice, priceData, tp, sl }) {
    try {
      const buffer = config.extendedConst.entryLimitBuffer; // 0.0005 = 0.05%
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

      // ─── Entry limit price: вплотную к лучшей цене книги ───
      let entryLimitPrice;
      if (side === 'BUY') {
        // Ставим чуть выше bestAsk — ложим заявку на вершину книги
        entryLimitPrice = (priceData.bestAsk || entryPrice) * (1 + buffer);
      } else {
        // Ставим чуть ниже bestBid
        entryLimitPrice = (priceData.bestBid || entryPrice) * (1 - buffer);
      }

      const expiryMs = Date.now() + config.extendedConst.maxExpiryMs;

      // ─── Параметри для 3 підписів (все GTT LIMIT, все maker) ───
      const entrySignParams = {
        market: symbol,
        side: side,
        type: 'LIMIT',
        qty: quantity.toString(),
        price: entryLimitPrice.toString(),
        timeInForce: 'GTT',                          // ← GTT, не IOC
        expiryEpochMillis: expiryMs,
        fee: config.extendedConst.makerFee            // ← maker 0%
      };

      const tpSignParams = {
        market: symbol,
        side: closeSide,
        type: 'LIMIT',
        qty: quantity.toString(),
        price: tp.limitPrice.toString(),
        timeInForce: 'GTT',
        expiryEpochMillis: expiryMs,
        fee: config.extendedConst.makerFee
      };

      const slSignParams = {
        market: symbol,
        side: closeSide,
        type: 'LIMIT',
        qty: quantity.toString(),
        price: sl.limitPrice.toString(),
        timeInForce: 'GTT',
        expiryEpochMillis: expiryMs,
        fee: config.extendedConst.makerFee
      };

      // ─── Підписуємо всі три ───
      const signatures = starkSigner.signFullOrder(entrySignParams, tpSignParams, slSignParams);

      // ─── Формуємо запит ───
      const externalId = starkSigner.generateExternalId();

      const orderRequest = {
        id: externalId,
        market: symbol,
        type: 'LIMIT',
        side: side,
        qty: quantity.toString(),
        price: entryLimitPrice.toString(),
        timeInForce: 'GTT',                          // ← GTT
        expiryEpochMillis: expiryMs,
        fee: config.extendedConst.makerFee,           // ← maker 0%
        nonce: signatures.entry.nonce.toString(),
        settlement: signatures.entry.settlement,

        tpSlType: 'ORDER',

        takeProfit: {
          triggerPrice: tp.triggerPrice.toString(),
          triggerPriceType: 'LAST',
          price: tp.limitPrice.toString(),
          priceType: 'LIMIT',
          settlement: signatures.tp.settlement
        },

        stopLoss: {
          triggerPrice: sl.triggerPrice.toString(),
          triggerPriceType: 'LAST',
          price: sl.limitPrice.toString(),
          priceType: 'LIMIT',
          settlement: signatures.sl.settlement
        }
      };

      logger.info(`[EXTENDED] Creating order with TP/SL: ${side} ${quantity} ${symbol}`);
      logger.info(`[EXTENDED]   Entry LIMIT: ${entryLimitPrice.toFixed(4)} (book: ask=${priceData.bestAsk}, bid=${priceData.bestBid})`);
      logger.info(`[EXTENDED]   TP: trigger=${tp.triggerPrice}, limit=${tp.limitPrice}`);
      logger.info(`[EXTENDED]   SL: trigger=${sl.triggerPrice}, limit=${sl.limitPrice}`);

      const response = await this.http.post('/user/order', orderRequest);

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Order with TP/SL failed: HTTP ${response.status} — ${JSON.stringify(response.data)}`);
      }

      const orderId = response.data?.id || response.data?.orderId || externalId;
      logger.info(`[EXTENDED] ✅ Order with TP/SL created: ID ${orderId}`);

      return {
        orderId: orderId,
        externalId: externalId,
        symbol: symbol,
        side: side,
        quantity: quantity,
        entryLimitPrice: entryLimitPrice,
        tp: tp,
        sl: sl
      };
    } catch (error) {
      logger.error(`[EXTENDED] Error creating order with TP/SL: ${error.message}`);
      throw error;
    }
  }

  /**
   * Скасує ордер по ID
   */
  async cancelOrder(orderId, symbol) {
    try {
      logger.info(`[EXTENDED] Cancelling order ${orderId}...`);

      const response = await this.http.delete('/user/order', {
        params: { id: orderId, market: symbol }
      });

      if (response.status === 200 || response.status === 204) {
        logger.info(`[EXTENDED] ✅ Order ${orderId} cancelled`);
        return true;
      }

      throw new Error(`Cancel failed: HTTP ${response.status}`);
    } catch (error) {
      logger.error(`[EXTENDED] Error cancelling order ${orderId}: ${error.message}`);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // POSITIONS
  // ═══════════════════════════════════════════════════════════

  /**
   * Отримує відкриті позиції
   * Аналог: bybitService.getOpenPositions()
   */
  async getPositions(symbol = null) {
    try {
      const params = {};
      if (symbol) {
        params.market = symbol;
      }

      const response = await this.http.get('/user/positions', { params });

      if (response.status !== 200) {
        throw new Error(`Failed to get positions: HTTP ${response.status}`);
      }

      const positions = (Array.isArray(response.data) ? response.data : [])
        .filter(pos => parseFloat(pos.size || pos.qty || '0') !== 0)
        .map(pos => ({
          symbol: pos.market || pos.symbol,
          side: pos.side,                                          // BUY / SELL
          direction: pos.side === 'BUY' ? 'LONG' : 'SHORT',      // Мапинг → LONG/SHORT
          size: parseFloat(pos.size || pos.qty || '0'),
          entryPrice: parseFloat(pos.avgPrice || pos.entryPrice || '0'),
          markPrice: parseFloat(pos.markPrice || '0'),
          unrealisedPnl: parseFloat(pos.unrealisedPnl || pos.pnl || '0'),
          leverage: parseFloat(pos.leverage || '1')
        }));

      return positions;
    } catch (error) {
      logger.error(`[EXTENDED] Error getting positions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Отримує история угод
   * Аналог: bybitService.getTradeHistory()
   */
  async getTradeHistory(symbol = null, limit = 50) {
    try {
      const params = { limit };
      if (symbol) {
        params.market = symbol;
      }

      const response = await this.http.get('/user/trades', { params });

      if (response.status !== 200) {
        throw new Error(`Failed to get trade history: HTTP ${response.status}`);
      }

      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      logger.error(`[EXTENDED] Error getting trade history: ${error.message}`);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════

  /**
   * Визначає кількість знаків після коми з step size
   * Наприклад: 0.001 → 3, 0.0001 → 4
   */
  _getPrecisionFromStep(step) {
    if (!step || step <= 0) return 4;
    const str = step.toString();
    const dotIndex = str.indexOf('.');
    if (dotIndex === -1) return 0;
    return str.length - dotIndex - 1;
  }
}

// Singleton
const extendedService = new ExtendedService();
export default extendedService;
