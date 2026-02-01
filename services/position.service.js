import extendedService from './extended.service.js';
import telegramService from './telegram.service.js';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';
import { calculatePnL, calculatePnLPercent, formatDuration } from '../utils/helpers.js';

/**
 * PositionService
 * 
 * Адаптация от Bybit:
 * - bybitService → extendedService
 * - pos.side теперь 'BUY'/'SELL' (Extended), маппим в LONG/SHORT
 * - Поля ответа: market вместо symbol, execPrice вместо price
 */
class PositionService {
  constructor() {
    this.openPositions = new Map(); // symbol → position data
    this.closedPositions = [];
    this.monitoringInterval = null;
  }

  // ═══════════════════════════════════════════════════════════
  // POSITION TRACKING
  // ═══════════════════════════════════════════════════════════

  /**
   * Додає позицію до моніторингу
   */
  addOpenPosition(positionData) {
    const { symbol, direction, entryPrice, quantity, takeProfit, stopLoss, orderId, timestamp } = positionData;

    this.openPositions.set(symbol, {
      symbol,
      direction,            // LONG | SHORT
      entryPrice,
      quantity,
      takeProfit,           // { triggerPrice, limitPrice } — Extended формат
      stopLoss,             // { triggerPrice, limitPrice }
      orderId,
      timestamp: timestamp || Date.now(),
      externalId: positionData.externalId || null
    });

    logger.info(`[POSITION] Added: ${symbol} ${direction} @ ${entryPrice}`);
  }

  /**
   * Видаляє позицію з моніторингу
   */
  removeOpenPosition(symbol) {
    const position = this.openPositions.get(symbol);
    if (position) {
      this.openPositions.delete(symbol);
      logger.info(`[POSITION] Removed: ${symbol}`);
      return position;
    }
    return null;
  }

  /**
   * Додає закриту позицію
   */
  addClosedPosition(positionData) {
    this.closedPositions.push({
      ...positionData,
      closedAt: Date.now()
    });
    logger.info(`[POSITION] Closed: ${positionData.symbol}, P&L: ${positionData.pnl.toFixed(2)}`);
  }

  hasOpenPosition(symbol) {
    return this.openPositions.has(symbol);
  }

  getOpenPosition(symbol) {
    return this.openPositions.get(symbol);
  }

  getAllOpenPositions() {
    return Array.from(this.openPositions.values());
  }

  getOpenPositionsCount() {
    return this.openPositions.size;
  }

  // ═══════════════════════════════════════════════════════════
  // MONITORING
  // ═══════════════════════════════════════════════════════════

  startMonitoring(intervalMs = 30000) {
    if (this.monitoringInterval) {
      logger.warn('[POSITION] Monitoring already running');
      return;
    }

    logger.info('[POSITION] Starting position monitoring...');
    this.monitoringInterval = setInterval(async () => {
      await this.checkPositions();
    }, intervalMs);
  }

  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      logger.info('[POSITION] Monitoring stopped');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // POSITION CHECK LOOP
  // ═══════════════════════════════════════════════════════════

  /**
   * Перевіряє статус всіх tracked позицій через Extended API.
   * 
   * Extended повертає side: 'BUY'/'SELL'.
   * Якщо позиція пропала або size=0 → вона закрита (TP/SL срабатила).
   */
  async checkPositions() {
    try {
      if (this.openPositions.size === 0) return;

      for (const [symbol, trackedPosition] of this.openPositions.entries()) {
        try {
          const exchangePositions = await extendedService.getPositions(symbol);

          // Шукаємо позицію по символу та напрямку
          const expectedSide = trackedPosition.direction === 'LONG' ? 'BUY' : 'SELL';
          const exchangePosition = exchangePositions.find(
            pos => (pos.symbol === symbol || pos.market === symbol) && pos.side === expectedSide
          );

          if (!exchangePosition || parseFloat(exchangePosition.size) === 0) {
            // Позиція закрита на біржі (TP або SL срабатила)
            await this.handlePositionClosed(symbol, trackedPosition);
          } else {
            // Позиція всё ещё открыта
            await this.updatePositionData(symbol, exchangePosition);
          }
        } catch (error) {
          logger.error(`[POSITION] Error checking ${symbol}: ${error.message}`);
          continue; // Продовжаємо перевірку інших
        }
      }
    } catch (error) {
      logger.error(`[POSITION] Error in checkPositions: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // POSITION CLOSED HANDLER
  // ═══════════════════════════════════════════════════════════

  /**
   * Обрабатывает закрытие позиции.
   * 
   * Адаптация: Extended trade history содержит поля:
   *   market (вместо symbol), execPrice, side ('BUY'/'SELL')
   */
  async handlePositionClosed(symbol, trackedPosition) {
    try {
      // Ищем закрывающую сделку в истории
      const trades = await extendedService.getTradeHistory(symbol, 10);

      // Закрывающая сторона — противоположная entry
      const closeSide = trackedPosition.direction === 'LONG' ? 'SELL' : 'BUY';

      const closeTrade = trades.find(t =>
        (t.market === symbol || t.symbol === symbol) &&
        t.side === closeSide
      );

      const exitPrice = closeTrade
        ? parseFloat(closeTrade.execPrice || closeTrade.price || '0')
        : trackedPosition.entryPrice;

      const duration = Math.floor((Date.now() - trackedPosition.timestamp) / 1000);

      // P&L
      const pnl = calculatePnL(
        trackedPosition.entryPrice,
        exitPrice,
        trackedPosition.quantity,
        trackedPosition.direction
      );

      const pnlPercent = calculatePnLPercent(
        trackedPosition.entryPrice,
        exitPrice,
        trackedPosition.direction
      );

      const closedPositionData = {
        ...trackedPosition,
        exitPrice,
        pnl,
        pnlPercent,
        duration: formatDuration(duration)
      };

      // Сохраняем + удаляем из open
      this.addClosedPosition(closedPositionData);
      this.removeOpenPosition(symbol);

      // Telegram уведомление
      if (!config.trading.dryRun) {
        try {
          await telegramService.sendMessage(
            config.telegram.channelId,
            telegramService.formatPositionClosedMessage(closedPositionData)
          );
        } catch (telegramError) {
          logger.error(`[POSITION] Telegram send error: ${telegramError.message}`);
        }
      }

      logger.info(`[POSITION] Closed: ${symbol}, P&L: ${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);
    } catch (error) {
      logger.error(`[POSITION] Error handling closed position: ${error.message}`);
    }
  }

  /**
   * Обновляет данные открытой позиции
   */
  async updatePositionData(symbol, exchangePosition) {
    const trackedPosition = this.openPositions.get(symbol);
    if (!trackedPosition) return;

    const unrealisedPnl = parseFloat(exchangePosition.unrealisedPnl || '0');
    logger.debug(`[POSITION] ${symbol}: Unrealised P&L: ${unrealisedPnl.toFixed(2)}`);
  }

  // ═══════════════════════════════════════════════════════════
  // STATISTICS
  // ═══════════════════════════════════════════════════════════

  getStatistics() {
    const totalTrades = this.closedPositions.length;
    const winTrades = this.closedPositions.filter(p => p.pnl >= 0).length;
    const loseTrades = totalTrades - winTrades;
    const totalPnl = this.closedPositions.reduce((sum, p) => sum + p.pnl, 0);

    return {
      totalTrades,
      winTrades,
      loseTrades,
      totalPnl,
      openPositions: this.openPositions.size,
      closedPositions: totalTrades
    };
  }

  resetDailyStatistics() {
    this.closedPositions = [];
    logger.info('[POSITION] Daily statistics reset');
  }
}

// Singleton
const positionService = new PositionService();
export default positionService;
