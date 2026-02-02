import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';

/**
 * Нормалізує напрямок угоди на основі типу сигналу.
 *
 * Логіка:
 * - LONG FLUSH      → завжди SHORT (протилежно flush!)
 * - SHORT SQUEEZE   → завжди LONG (протилежно squeeze!)
 * - Інші типи       → використовуємо direction як є
 */
function normalizeDirection(rawDirection, rawSignalType) {
  const direction = (rawDirection || '').toUpperCase();
  const signalType = (rawSignalType || '').toUpperCase().replace(/\s+/g, '_');

  // ✅ ВАЖЛИВО: LONG FLUSH = ціна падає → SHORT позиція!
  if (signalType === 'LONG_FLUSH') {
    return 'SHORT';
  }

  // ✅ ВАЖЛИВО: SHORT SQUEEZE = ціна росте → LONG позиція!
  if (signalType === 'SHORT_SQUEEZE') {
    return 'LONG';
  }

  // За замовчуванням довіряємо direction
  if (direction === 'LONG' || direction === 'SHORT') {
    return direction;
  }

  // Fallback
  return 'LONG';
}

/**
 * ✅ НОВА ФУНКЦІЯ: Парсить JSON з тексту
 * Витягує JSON блок з повідомлення
 */
function parseJsonSignal(text) {
  if (!text) return {};

  const startIdx = text.indexOf('{');
  if (startIdx === -1) return {};

  let depth = 0;
  let endIdx = -1;

  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx === -1) return {};

  try {
    return JSON.parse(text.substring(startIdx, endIdx + 1));
  } catch (e) {
    logger.warn(`[TELEGRAM] JSON parse failed: ${e.message}`);
    return {};
  }
}

/**
 * ✅ ВИПРАВЛЕНА ФУНКЦІЯ: Конвертує символ Bybit → Extended
 * 
 * Extended.exchange використовує формат: BTC-USD, ETH-USD, ADA-USD
 * (collateral = USDC, але в назві символу використовується -USD)
 * 
 * Конвертація:
 *   ADAUSDT  → ADA-USD
 *   BTCUSDT  → BTC-USD
 *   ETHUSDT  → ETH-USD
 *   SOLUSDT  → SOL-USD
 */
function normalizeSymbol(rawSymbol) {
  if (!rawSymbol) return null;

  const sym = rawSymbol.toUpperCase().trim();

  // Якщо вже в Extended форматі (містить '-')
  if (sym.includes('-')) {
    return sym;
  }

  // Видаляємо USDT/USDC/USD суфікси
  let base = sym;
  for (const suffix of ['USDT', 'USDC', 'USD']) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }

  // ✅ Extended формат: BASE-USD (не -USDC!)
  return `${base}-USD`;
}

class TelegramService {
  constructor() {
    this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
    this.channelId = config.telegram.channelId;
    this.signalCallbacks = [];
    
    this.setupMessageHandler();
  }

  /**
   * Налаштовує обробник повідомлень
   */
  setupMessageHandler() {
    // Слухаємо повідомлення З КАНАЛУ
    this.bot.on('channel_post', (msg) => {
      if (msg.chat.id.toString() === this.channelId.toString()) {
        this.handleChannelMessage(msg);
      }
    });
  
    this.bot.on('polling_error', (error) => {
      logger.error(`[TELEGRAM] Polling error: ${error.message}`);
    });
  
    logger.info('[TELEGRAM] ✅ Bot initialized and listening for channel posts');
  }

  /**
   * ✅ ВИПРАВЛЕНА ФУНКЦІЯ: Обробка повідомлення з каналу
   */
  async handleChannelMessage(msg) {
    try {
      const text = msg.text || msg.caption || '';
      
      logger.info(`[TELEGRAM] Received message: ${text.substring(0, 100)}...`);

      // 1. Витягуємо JSON (якщо є)
      const signalData = parseJsonSignal(text);

      // 2. Шукаємо Symbol (спочатку в JSON, потім у тексті)
      let symbol = signalData.symbol;
      if (!symbol) {
        const symbolMatch = text.match(/Symbol:\s*([A-Z0-9]+)/i);
        if (symbolMatch) symbol = symbolMatch[1];
      }

      // ✅ 3. КОНВЕРТУЄМО СИМВОЛ (Bybit → Extended)
      if (symbol) {
        symbol = normalizeSymbol(symbol);
        logger.info(`[TELEGRAM] Normalized symbol: ${symbol}`);
      }

      // 4. Шукаємо Direction (спочатку в JSON, потім у тексті)
      let direction = signalData.direction;
      if (!direction) {
        const directionMatch = text.match(/Direction:\s*(LONG|SHORT)/i);
        if (directionMatch) direction = directionMatch[1];
      }

      // 5. Шукаємо Type (спочатку в JSON, потім у тексті)
      let signalType = signalData.signalType;
      if (!signalType) {
        const typeMatch = text.match(/Type:\s*([^\n\r]+)/i);
        if (typeMatch) signalType = typeMatch[1]?.trim();
      }

      // ✅ 6. НОРМАЛІЗУЄМО DIRECTION (LONG FLUSH → SHORT!)
      const finalDirection = normalizeDirection(direction, signalType);

      logger.info(`[TELEGRAM] Parsed signal:`);
      logger.info(`  Symbol: ${symbol}`);
      logger.info(`  Type: ${signalType}`);
      logger.info(`  Raw Direction: ${direction}`);
      logger.info(`  Final Direction: ${finalDirection}`);

      // 7. Якщо є символ — відправляємо сигнал
      if (symbol) {
        const signal = {
          symbol: symbol,
          direction: finalDirection,
          signalType: signalType || 'UNKNOWN',
          timestamp: signalData.timestamp || Date.now(),
          stats: signalData.stats || {}
        };

        logger.info(`[TELEGRAM] ✅ Triggering callbacks for ${symbol} ${finalDirection}`);

        // Викликаємо callbacks
        for (const callback of this.signalCallbacks) {
          try {
            await callback(signal);
          } catch (error) {
            logger.error(`[TELEGRAM] Callback error: ${error.message}`);
          }
        }
      } else {
        logger.warn(`[TELEGRAM] ⚠️ No symbol found in message`);
      }

    } catch (error) {
      logger.error(`[TELEGRAM] Error handling message: ${error.message}`);
      logger.error(`[TELEGRAM] Stack: ${error.stack}`);
    }
  }

  /**
   * Реєструє callback для обробки сигналів
   */
  onSignal(callback) {
    this.signalCallbacks.push(callback);
    logger.info('[TELEGRAM] Signal callback registered');
  }

  /**
   * Відправляє повідомлення в канал або чат
   */
  async sendMessage(chatId, message, options = {}) {
    try {
      const targetChatId = chatId || this.channelId;
      await this.bot.sendMessage(targetChatId, message, {
        parse_mode: 'HTML',
        ...options
      });
      logger.info(`[TELEGRAM] Message sent to ${targetChatId}`);
    } catch (error) {
      logger.error(`[TELEGRAM] Error sending message: ${error.message}`);
      throw error;
    }
  }

  /**
   * Форматує повідомлення про відкриття позиції
   */
  formatPositionOpenedMessage(positionData) {
    const { 
      symbol, 
      direction, 
      entryPrice, 
      quantity, 
      leverage, 
      takeProfit,
      stopLoss,
      riskAmount,
      balance
    } = positionData;
    
    const cleanSymbol = symbol ? symbol.replace('-USD', '') : 'UNKNOWN';
    const directionEmoji = direction === 'LONG' ? '📈' : '📉';

    const tpPercent = direction === 'LONG'
      ? (((takeProfit.triggerPrice - entryPrice) / entryPrice) * 100).toFixed(2)
      : (((entryPrice - takeProfit.triggerPrice) / entryPrice) * 100).toFixed(2);
    
    const slPercent = direction === 'LONG'
      ? (((entryPrice - stopLoss.triggerPrice) / entryPrice) * 100).toFixed(2)
      : (((stopLoss.triggerPrice - entryPrice) / entryPrice) * 100).toFixed(2);
    
    const balancePercent = balance && riskAmount
      ? (riskAmount / balance * 100).toFixed(2)
      : '0.00';
    
    return `✅ <b>POSITION OPENED</b>
  
<b>Symbol:</b> ${symbol}
<b>Direction:</b> ${directionEmoji} ${direction}
<b>Entry Price:</b> $${entryPrice}
<b>Quantity:</b> ${quantity.toLocaleString()} ${cleanSymbol}
<b>Leverage:</b> ${leverage}x
  
🎯 <b>Take Profit:</b> trigger $${takeProfit.triggerPrice} → limit $${takeProfit.limitPrice} (+${tpPercent}%)
🛑 <b>Stop Loss:</b> trigger $${stopLoss.triggerPrice} → limit $${stopLoss.limitPrice} (-${slPercent}%)
💰 <b>Risk:</b> $${riskAmount.toFixed(2)} (${balancePercent}% of balance)
📝 <b>TP/SL Type:</b> LIMIT orders (maker fees)
  
Signal from: ${new Date(positionData.timestamp).toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
  }

  /**
   * Форматує повідомлення про закриття позиції
   */
  formatPositionClosedMessage(positionData) {
    const { symbol, direction, entryPrice, exitPrice, pnl, pnlPercent, duration } = positionData;
    
    const isProfit = pnl >= 0;
    const emoji = isProfit ? '🟢' : '🔴';
    const resultText = isProfit ? 'PROFIT' : 'LOSS';
    
    return `${emoji} <b>POSITION CLOSED - ${resultText}</b>

<b>Symbol:</b> ${symbol}
<b>Direction:</b> ${direction}
<b>Entry:</b> $${entryPrice}
<b>Exit:</b> $${exitPrice}
<b>Result:</b> ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}% (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})

<b>Duration:</b> ${duration}`;
  }

  /**
   * Форматує повідомлення про ігнорування сигналу
   */
  formatSignalIgnoredMessage(symbol, direction, reason, additionalInfo = {}) {
    let message = `⏰ <b>SIGNAL IGNORED</b>

<b>Symbol:</b> ${symbol}
<b>Direction:</b> ${direction}
<b>Reason:</b> ${reason}`;

    if (additionalInfo.currentTime) {
      message += `\n\n<b>Current time:</b> ${additionalInfo.currentTime} UTC`;
    }
    
    if (additionalInfo.tradingHours) {
      message += `\n<b>Trading hours:</b> ${additionalInfo.tradingHours}`;
    }
    
    if (additionalInfo.nextTrading) {
      message += `\n<b>Next trading:</b> in ${additionalInfo.nextTrading}`;
    }

    return message;
  }

  /**
   * Форматує щоденний звіт
   */
  formatDailyReport(report) {
    const winRate = report.totalTrades > 0 
      ? ((report.winTrades / report.totalTrades) * 100).toFixed(1)
      : '0.0';
    
    const pnlEmoji = report.totalPnl >= 0 ? '💰' : '📉';
    const roiEmoji = report.roi >= 0 ? '📈' : '📉';
    
    return `📊 <b>DAILY REPORT — Extended.exchange</b>

<b>Date:</b> ${report.date}
<b>Trading Hours:</b> ${report.tradingHours.start}:00-${report.tradingHours.end}:00 UTC
<b>Total Signals:</b> ${report.totalSignals}
<b>Signals Ignored (off-hours):</b> ${report.signalsIgnored}
<b>Total Trades:</b> ${report.totalTrades}
✅ <b>Wins:</b> ${report.winTrades} (${winRate}%)
❌ <b>Losses:</b> ${report.loseTrades} (${(100 - parseFloat(winRate)).toFixed(1)}%)
${pnlEmoji} <b>Total P&L:</b> ${report.totalPnl >= 0 ? '+' : ''}$${report.totalPnl.toFixed(2)}
${roiEmoji} <b>ROI:</b> ${report.roi >= 0 ? '+' : ''}${report.roi.toFixed(2)}%

<b>Balance:</b> $${report.startBalance.toFixed(2)} → $${report.currentBalance.toFixed(2)}`;
  }
}

// Singleton
const telegramService = new TelegramService();
export default telegramService;
