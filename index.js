import dotenv from 'dotenv';

// 🔹 Завантажуємо .env ТІЛЬКИ локально
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

import { config } from './config/settings.js';
import logger from './utils/logger.js';
import extendedService from './services/extended.service.js';
import telegramService from './services/telegram.service.js';
import positionService from './services/position.service.js';
import riskService from './services/risk.service.js';
import { isTradingHoursActive, getTradingHoursInfo } from './services/time.service.js';
import { isSymbolAllowed, getCurrentDate } from './utils/helpers.js';


// Статистика
const statistics = {
  totalTrades: 0,
  winTrades: 0,
  loseTrades: 0,
  totalProfit: 0,
  startBalance: 0,
  currentBalance: 0,
  dailyTrades: 0,
  signalsIgnored: 0,
  totalSignals: 0,
  lastResetDate: getCurrentDate()
};

/**
 * Ініціалізація бота
 */
async function initialize() {
  try {
    logger.info('='.repeat(60));
    logger.info('  Extended.exchange Futures Trading Bot');
    logger.info('='.repeat(60));

    // Підключення до Extended API
    await extendedService.connect();
    
    // Отримуємо початковий баланс
    statistics.startBalance = await extendedService.getBalance();
    statistics.currentBalance = statistics.startBalance;
    
    logger.info(`[INIT] Starting balance: ${statistics.startBalance}`);
    logger.info(`[INIT] Dry Run mode: ${config.trading.dryRun ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`[INIT] Allowed symbols: ${config.trading.allowedSymbols.join(', ')}`);
    logger.info(`[INIT] Risk: ${config.risk.percentage}%, Leverage: ${config.risk.leverage}x`);
    logger.info(`[INIT] TP: ${config.risk.takeProfitPercent}% | SL: ${config.risk.stopLossPercent}%`);
    logger.info(`[INIT] TP/SL type: LIMIT orders (maker fees)`);
    logger.info(`[INIT] Trading hours: ${config.tradingHours.startHour}:00-${config.tradingHours.endHour}:00 UTC`);

    // Реєструємо обробник сигналів
    telegramService.onSignal(handleSignal);

    // Запускаємо моніторинг позицій
    positionService.startMonitoring(30000); // Кожні 30 секунд

    // Повідомлення про запуск
    if (!config.trading.dryRun) {
      await telegramService.sendMessage(
        config.telegram.channelId,
        `🤖 <b>EXTENDED TRADING BOT STARTED</b>\n\n` +
        `Balance: ${statistics.startBalance.toFixed(2)}\n` +
        `Mode: ${config.trading.dryRun ? 'DRY RUN' : 'LIVE TRADING'}\n` +
        `TP/SL: LIMIT orders (maker fees)\n` +
        `Trading hours: ${config.tradingHours.startHour}:00-${config.tradingHours.endHour}:00 UTC`
      );
    }

    logger.info('[INIT] ✅ Bot initialized and ready to trade');
    
    // Щоденний звіт
    scheduleDailyReport();
    
  } catch (error) {
    logger.error(`[INIT] Initialization failed: ${error.message}`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL HANDLING
// ═══════════════════════════════════════════════════════════════

/**
 * Обработка торговельного сигналу
 */
async function handleSignal(signal) {
  try {
    statistics.totalSignals++;
    
    const { symbol, direction, timestamp } = signal;
    
    logger.info(`[SIGNAL] Processing: ${symbol} ${direction}`);

    // Валідація сигналу
    const validation = await validateSignal(signal);
    
    if (!validation.valid) {
      logger.warn(`[SIGNAL] Validation failed: ${validation.reason}`);
      
      try {
        if (!config.trading.dryRun) {
          await telegramService.sendMessage(
            config.telegram.channelId,
            telegramService.formatSignalIgnoredMessage(symbol, direction, validation.reason, validation.info)
          );
        }
      } catch (telegramError) {
        logger.error(`[SIGNAL] Error sending ignored message: ${telegramError.message}`);
      }
      
      if (validation.reason.includes('trading hours')) {
        statistics.signalsIgnored++;
      }
      
      return;
    }

    // Відкриваємо позицію
    await openPosition(signal);
    
  } catch (error) {
    logger.error(`[SIGNAL] Error handling signal: ${error.message}`);
    logger.error(`[SIGNAL] Stack: ${error.stack}`);
    
    try {
      if (!config.trading.dryRun) {
        await telegramService.sendMessage(
          config.telegram.channelId,
          `❌ <b>ERROR PROCESSING SIGNAL</b>\n\n` +
          `Symbol: ${signal?.symbol || 'UNKNOWN'}\n` +
          `Direction: ${signal?.direction || 'UNKNOWN'}\n` +
          `Error: ${error.message}`
        );
      }
    } catch (telegramError) {
      logger.error(`[SIGNAL] Error sending error message: ${telegramError.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════

/**
 * Валідація сигналу перед відкриттям позиції
 */
async function validateSignal(signal) {
  const { symbol, direction } = signal;

  // 1. Символ в списку
  if (!isSymbolAllowed(symbol, config.trading.allowedSymbols.join(','))) {
    return {
      valid: false,
      reason: `Symbol ${symbol} not in allowed list (${config.trading.allowedSymbols.join(', ')})`,
      info: {}
    };
  }

  // 2. Напрямок
  if (direction !== 'LONG' && direction !== 'SHORT') {
    return {
      valid: false,
      reason: `Invalid direction: ${direction}`,
      info: {}
    };
  }

  // 3. Торговельні години
  if (!isTradingHoursActive()) {
    const hoursInfo = getTradingHoursInfo();
    return {
      valid: false,
      reason: 'Outside trading hours',
      info: {
        currentTime: `${hoursInfo.currentHour}:${String(hoursInfo.currentMinute).padStart(2, '0')}`,
        tradingHours: `${hoursInfo.startHour}:00-${hoursInfo.endHour}:00`,
        nextTrading: hoursInfo.nextTradingIn
      }
    };
  }

  // 4. Відкрита позиція по цьому символу
  if (positionService.hasOpenPosition(symbol)) {
    return {
      valid: false,
      reason: `Open position already exists for ${symbol}`,
      info: {}
    };
  }

  // 5. Макс кількість позицій
  if (positionService.getOpenPositionsCount() >= config.trading.maxOpenPositions) {
    return {
      valid: false,
      reason: `Maximum open positions (${config.trading.maxOpenPositions}) reached`,
      info: {}
    };
  }

  // 6. Макс угод на день
  if (statistics.dailyTrades >= config.trading.maxDailyTrades) {
    return {
      valid: false,
      reason: `Maximum daily trades (${config.trading.maxDailyTrades}) reached`,
      info: {}
    };
  }

  // 7. Баланс
  try {
    const balance = await extendedService.getBalance();
    statistics.currentBalance = balance;
    
    if (balance <= 0) {
      return {
        valid: false,
        reason: 'Insufficient balance',
        info: {}
      };
    }
  } catch (error) {
    return {
      valid: false,
      reason: `Error checking balance: ${error.message}`,
      info: {}
    };
  }

  // 8. Market aktive та існує
  try {
    const marketInfo = await extendedService.getMarketInfo(symbol);
    if (marketInfo.status !== 'Trading') {
      return {
        valid: false,
        reason: `Market ${symbol} is not trading (status: ${marketInfo.status})`,
        info: {}
      };
    }

    // Перевірка leverage ≤ maxLeverage
    if (config.risk.leverage > marketInfo.maxLeverage) {
      return {
        valid: false,
        reason: `Leverage ${config.risk.leverage}x exceeds max for ${symbol} (${marketInfo.maxLeverage}x)`,
        info: {}
      };
    }
  } catch (error) {
    return {
      valid: false,
      reason: `Market ${symbol} not found or error: ${error.message}`,
      info: {}
    };
  }

  return { valid: true };
}

// ═══════════════════════════════════════════════════════════════
// OPEN POSITION — core trading logic
// ═══════════════════════════════════════════════════════════════

/**
 * Відкриття позиції на Extended.exchange
 * 
 * Всі ордери — LIMIT GTT, maker fee = 0%:
 * - Entry: LIMIT чуть выше bestAsk (BUY) / чуть ниже bestBid (SELL), буфер 0.05%
 * - TP:    LIMIT чуть выше trigger (LONG) / чуть ниже (SHORT)
 * - SL:    LIMIT чуть ниже trigger (LONG) / чуть выше (SHORT)
 * 
 * Один запит createOrderWithTPSL, 3 окремих Stark підписи всередині.
 */
async function openPosition(signal) {
  const { symbol, direction, timestamp } = signal;
  
  try {
    logger.info(`[TRADE] Opening position: ${symbol} ${direction}`);

    // 1. Баланс
    const balance = await extendedService.getBalance();
    statistics.currentBalance = balance;

    // 2. Ціна + order book top (нужно bestBid/bestAsk для IOC buffer)
    const priceData = await extendedService.getCurrentPrice(symbol);
    const currentPrice = priceData.lastPrice;
    
    // 3. Market info (для round precision, min qty, etc.)
    const marketInfo = await extendedService.getMarketInfo(symbol);

    // 4. Розрахунок параметрів позиції (qty, margin, TP/SL)
    const positionParams = riskService.calculatePositionParameters(
      balance,
      currentPrice,
      direction,
      marketInfo
    );

    // 5. Перевірка маржі
    if (!riskService.hasSufficientBalance(balance, positionParams.requiredMargin)) {
      throw new Error(
        `Insufficient balance. Required: ${positionParams.requiredMargin.toFixed(2)}, Available: ${balance.toFixed(2)}`
      );
    }

    // ─── DRY RUN ─────────────────────────────────────────────
    if (config.trading.dryRun) {
      logger.info('[DRY RUN] Would open position:');
      logger.info(`  Symbol:    ${symbol}`);
      logger.info(`  Direction: ${direction}`);
      logger.info(`  Entry:     ${positionParams.entryPrice}`);
      logger.info(`  Quantity:  ${positionParams.quantity}`);
      logger.info(`  Leverage:  ${positionParams.leverage}x`);
      logger.info(`  Margin:    ${positionParams.requiredMargin.toFixed(2)}`);
      logger.info(`  TP: trigger=${positionParams.takeProfit.triggerPrice}, limit=${positionParams.takeProfit.limitPrice}`);
      logger.info(`  SL: trigger=${positionParams.stopLoss.triggerPrice}, limit=${positionParams.stopLoss.limitPrice}`);
      
      // Симулируем открытие
      positionService.addOpenPosition({
        symbol,
        direction,
        entryPrice: positionParams.entryPrice,
        quantity: positionParams.quantity,
        takeProfit: positionParams.takeProfit,
        stopLoss: positionParams.stopLoss,
        orderId: 'DRY_RUN_' + Date.now(),
        externalId: 'DRY_RUN_EXT_' + Date.now(),
        timestamp
      });

      statistics.totalTrades++;
      statistics.dailyTrades++;
      
      return;
    }

    // ─── LIVE TRADING ────────────────────────────────────────
    const side = direction === 'LONG' ? 'BUY' : 'SELL';

    // 1. Встановлюємо leverage
    await extendedService.setLeverage(symbol, config.risk.leverage);

    // 2. Відкриваємо позицію: entry + TP + SL за один запит
    //    Всі три — LIMIT GTT, maker fee 0%. Всередині: 3 Stark підписи.
    const orderResult = await extendedService.createOrderWithTPSL({
      symbol,
      side,
      quantity: positionParams.quantity,
      entryPrice: positionParams.entryPrice,
      priceData,                              // { bestBid, bestAsk } для IOC buffer
      tp: positionParams.takeProfit,          // { triggerPrice, limitPrice }
      sl: positionParams.stopLoss             // { triggerPrice, limitPrice }
    });

    // 3. Додаємо позицію до моніторингу
    positionService.addOpenPosition({
      symbol,
      direction,
      entryPrice: positionParams.entryPrice,
      quantity: positionParams.quantity,
      takeProfit: positionParams.takeProfit,
      stopLoss: positionParams.stopLoss,
      orderId: orderResult.orderId,
      externalId: orderResult.externalId,
      timestamp
    });

    // 4. Статистика
    statistics.totalTrades++;
    statistics.dailyTrades++;

    // 5. Telegram
    await telegramService.sendMessage(
      config.telegram.channelId,
      telegramService.formatPositionOpenedMessage({
        symbol,
        direction,
        entryPrice: positionParams.entryPrice,
        quantity: positionParams.quantity,
        leverage: positionParams.leverage,
        takeProfit: positionParams.takeProfit,
        stopLoss: positionParams.stopLoss,
        riskAmount: positionParams.riskAmount,
        balance,
        timestamp
      })
    );

    logger.info(`[TRADE] ✅ Position opened: ${symbol} ${direction} | Order: ${orderResult.orderId}`);

  } catch (error) {
    logger.error(`[TRADE] Error opening position: ${error.message}`);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// DAILY REPORT
// ═══════════════════════════════════════════════════════════════

function scheduleDailyReport() {
  const now = new Date();
  const reportTime = new Date();
  reportTime.setUTCHours(23, 0, 0, 0);
  
  if (reportTime <= now) {
    reportTime.setUTCDate(reportTime.getUTCDate() + 1);
  }
  
  const msUntilReport = reportTime - now;
  
  setTimeout(() => {
    sendDailyReport();
    setInterval(sendDailyReport, 24 * 60 * 60 * 1000);
  }, msUntilReport);
  
  logger.info(`[REPORT] Daily report scheduled for ${reportTime.toISOString()}`);
}

async function sendDailyReport() {
  try {
    const currentDate = getCurrentDate();
    
    if (currentDate !== statistics.lastResetDate) {
      statistics.dailyTrades = 0;
      statistics.signalsIgnored = 0;
      statistics.lastResetDate = currentDate;
      positionService.resetDailyStatistics();
    }

    const posStats = positionService.getStatistics();
    const currentBalance = await extendedService.getBalance();
    const startBalance = statistics.startBalance;
    const totalPnl = currentBalance - startBalance;
    const roi = startBalance > 0 ? (totalPnl / startBalance) * 100 : 0;

    const report = {
      date: currentDate,
      tradingHours: {
        start: config.tradingHours.startHour,
        end: config.tradingHours.endHour
      },
      totalSignals: statistics.totalSignals,
      signalsIgnored: statistics.signalsIgnored,
      totalTrades: posStats.totalTrades,
      winTrades: posStats.winTrades,
      loseTrades: posStats.loseTrades,
      totalPnl: totalPnl,
      roi: roi,
      startBalance: startBalance,
      currentBalance: currentBalance
    };

    if (!config.trading.dryRun) {
      await telegramService.sendMessage(
        config.telegram.channelId,
        telegramService.formatDailyReport(report)
      );
    }

    logger.info('[REPORT] Daily report sent');
  } catch (error) {
    logger.error(`[REPORT] Error sending daily report: ${error.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════

process.on('SIGINT', async () => {
  logger.info('\n[SHUTDOWN] Received SIGINT, shutting down gracefully...');
  
  positionService.stopMonitoring();
  
  if (!config.trading.dryRun) {
    try {
      await telegramService.sendMessage(
        config.telegram.channelId,
        `🛑 <b>EXTENDED TRADING BOT STOPPED</b>\n\n` +
        `Open positions: ${positionService.getOpenPositionsCount()}\n` +
        `Total trades today: ${statistics.dailyTrades}`
      );
    } catch (e) {
      logger.error(`[SHUTDOWN] Telegram notification failed: ${e.message}`);
    }
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('\n[SHUTDOWN] Received SIGTERM, shutting down gracefully...');
  positionService.stopMonitoring();
  process.exit(0);
});

// ─── START ───
initialize().catch(error => {
  logger.error(`[FATAL] Failed to start bot: ${error.message}`);
  process.exit(1);
});
