import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';

/**
 * Нормалізує напрямок угоди на основі типу сигналу.
 *
 * Логіка:
 * - LONG FLUSH      → завжди LONG (Buy)
 * - SHORT SQUEEZE   → завжди SHORT (Sell)
 * - Інші типи       → використовуємо те, що прийшло в direction (LONG/SHORT)
 */
function normalizeDirection(rawDirection, rawSignalType) {
  const direction = (rawDirection || '').toUpperCase();
  const signalType = (rawSignalType || '').toUpperCase().replace(/\s+/g, '_');

  if (signalType === 'LONG_FLUSH') {
    return 'LONG';
  }

  if (signalType === 'SHORT_SQUEEZE') {
    return 'SHORT';
  }

  // За замовчуванням довіряємо direction, якщо він валідний
  if (direction === 'LONG' || direction === 'SHORT') {
    return direction;
  }

  // Якщо нічого валідного немає - повертаємо LONG як дефолт (далі все одно буде валідація)
  return 'LONG';
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
    // Слухаємо повідомлення З КАНАЛУ (а не з приватного чату)
    this.bot.on('channel_post', (msg) => {
      // Перевіряємо що це наш канал
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
   * Обробляє повідомлення з каналу
   */
  async handleChannelMessage(msg) {
    try {
      const text = msg.text || msg.caption || '';
      
      // Перевіряємо чи це structured сигнал
      if (this.isSignalMessage(text)) {
        const signal = this.parseSignal(text);
        
        if (signal) {
          logger.info(`[TELEGRAM] Signal received: ${signal.symbol} ${signal.direction}`);
          
          // Викликаємо всі зареєстровані callback'и
          for (const callback of this.signalCallbacks) {
            try {
              await callback(signal);
            } catch (error) {
              logger.error(`[TELEGRAM] Error in signal callback: ${error.message}`);
            }
          }
        }
      }
    } catch (error) {
      logger.error(`[TELEGRAM] Error handling message: ${error.message}`);
    }
  }

  /**
   * Перевіряє чи це сигнальне повідомлення
   */
  isSignalMessage(text) {
    if (!text) return false;
    
    // Перевіряємо наявність ключових слів
    const hasSignalKeyword = text.includes('SIGNAL DETECTED') || 
                            text.includes('🚨 SIGNAL');
    
    // Перевіряємо наявність JSON блоку
    const hasJsonBlock = text.includes('{') && text.includes('"symbol"') && text.includes('"direction"');
    
    return hasSignalKeyword && hasJsonBlock;
  }

  /**
   * Парсить сигнал з повідомлення
   */
  parseSignal(text) {
    try {
      // ─── Робуста екстракція JSON блоку через подсчёт фигурних скобок ───
      // Старий метод регексом /\{[\s\S]*"timestamp"[\s\S]*"symbol"...\}/
      // ЛОМАЕТСЯ когда ключи идут в другом порядке (JSON order не гарантирован!)
      const signalData = this._extractJSON(text);

      if (signalData && signalData.symbol && signalData.direction) {
        const rawSignalType = signalData.signalType || 'UNKNOWN';
        const normalizedSignalType = rawSignalType
          ? rawSignalType.toString().toUpperCase().replace(/\s+/g, '_')
          : 'UNKNOWN';

        const normalizedDir = normalizeDirection(
          signalData.direction,
          normalizedSignalType
        );

        const symbol = this.normalizeSymbol(signalData.symbol);

        return {
          symbol: symbol,
          direction: normalizedDir,
          signalType: normalizedSignalType,
          timestamp: signalData.timestamp || Date.now(),
          stats: signalData.stats || {}
        };
      }

      // Якщо JSON не знайдено або не містить нужних полів — парсимо з HTML
      return this.parseSignalFromHTML(text);
    } catch (error) {
      logger.error(`[TELEGRAM] Error parsing signal: ${error.message}`);
      return null;
    }
  }

  /**
   * Надійна екстракція JSON з тексту.
   * Знаходить перший '{', рахує вложенні скобки до відповідного '}'.
   * Потім пробує JSON.parse. Не залежить від порядку ключів.
   */
  _extractJSON(text) {
    const startIdx = text.indexOf('{');
    if (startIdx === -1) return null;

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

    if (endIdx === -1) return null;

    try {
      return JSON.parse(text.substring(startIdx, endIdx + 1));
    } catch (e) {
      logger.warn(`[TELEGRAM] JSON parse failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Парсить сигнал з HTML формату
   */
  parseSignalFromHTML(text) {
    try {
      // Парсимо Symbol
      const symbolMatch = text.match(/<b>Symbol:<\/b>\s*(\w+)/i) || 
                         text.match(/Symbol:\s*(\w+)/i);
      
      // Парсимо Type (LONG FLUSH / SHORT SQUEEZE)
      const typeMatch = text.match(/<b>Type:<\/b>\s*([A-Z\s_]+)/i) ||
                       text.match(/Type:\s*([A-Z\s_]+)/i);

      // Парсимо Direction
      const directionMatch = text.match(/<b>Direction:<\/b>\s*(LONG|SHORT)/i) ||
                            text.match(/Direction:\s*(LONG|SHORT)/i);
      
      if (!symbolMatch || !directionMatch) {
        return null;
      }
      
      const rawSignalType = typeMatch ? typeMatch[1] : 'UNKNOWN';
      const normalizedSignalType = rawSignalType
        ? rawSignalType.toString().toUpperCase().replace(/\s+/g, '_')
        : 'UNKNOWN';

      const normalizedDir = normalizeDirection(
        directionMatch[1],
        normalizedSignalType
      );

      const symbol = this.normalizeSymbol(symbolMatch[1]);

      return {
        symbol: symbol,
        direction: normalizedDir,
        signalType: normalizedSignalType,
        timestamp: Date.now(),
        stats: {}
      };
    } catch (error) {
      logger.error(`[TELEGRAM] Error parsing signal from HTML: ${error.message}`);
      return null;
    }
  }

  /**
   * Нормализует символ из формата Bybit (ADAUSDT) в формат Extended (ADA-USD).
   * 
   * Примеры:
   *   ADAUSDT   → ADA-USD
   *   BTCUSDT   → BTC-USD
   *   BTC-USD   → BTC-USD (уже в правильном формате)
   * 
   * Если символ уже в формате X-USD — не трогаем.
   */
  normalizeSymbol(rawSymbol) {
    if (!rawSymbol) return rawSymbol;

    const sym = rawSymbol.toUpperCase().trim();

    // Если уже в формате Extended (содержит '-')
    if (sym.includes('-')) {
      return sym;
    }

    // Удаляем суффикс USDT / USD / USDC
    let base = sym;
    for (const suffix of ['USDT', 'USDC', 'USD']) {
      if (base.endsWith(suffix)) {
        base = base.slice(0, -suffix.length);
        break;
      }
    }

    // Формируем Extended формат
    return `${base}-USD`;
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
   * 
   * Адаптация: takeProfit/stopLoss теперь объекты { triggerPrice, limitPrice }
   */
  formatPositionOpenedMessage(positionData) {
    const { 
      symbol, 
      direction, 
      entryPrice, 
      quantity, 
      leverage, 
      takeProfit,   // { triggerPrice, limitPrice }
      stopLoss,     // { triggerPrice, limitPrice }
      riskAmount,
      balance
    } = positionData;
    
    // Symbol без суффикса для display
    const cleanSymbol = symbol ? symbol.replace('-USD', '') : 'UNKNOWN';
    
    const directionEmoji = direction === 'LONG' ? '📈' : '📉';

    // TP/SL % от entry
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
