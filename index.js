// ============================================================================
// BINANCE LIQUIDATION MONITOR - СПРОЩЕНА ВЕРСІЯ
// Моніторинг ліквідацій для конкретних монет
// ============================================================================

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// ============================================================================
// КОНФІГУРАЦІЯ
// ============================================================================

const CONFIG = {
  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  
  // Фільтр ліквідацій
  LIQUIDATION_THRESHOLD: parseFloat(process.env.LIQUIDATION_THRESHOLD) || 10000, // USD
  TIME_WINDOW_MINUTES: parseInt(process.env.TIME_WINDOW_MINUTES) || 7, // хвилини
  
  // Монети для відстеження (через кому в .env)
  SYMBOLS: process.env.SYMBOLS ? process.env.SYMBOLS.split(',').map(s => s.trim().toUpperCase()) : [],
  
  // WebSocket
  RECONNECT_DELAY: 5000
};

// Генеруємо WebSocket URL для конкретних монет
// Формат: wss://fstream.binance.com/stream?streams=btcusdt@forceOrder/ethusdt@forceOrder
function generateWebSocketURL(symbols) {
  const streams = symbols.map(s => `${s.toLowerCase()}@forceOrder`).join('/');
  return `wss://fstream.binance.com/stream?streams=${streams}`;
}

// ============================================================================
// КЛАС МОНІТОРА ЛІКВІДАЦІЙ
// ============================================================================

class LiquidationMonitor {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.bot = null;
    this.reconnectAttempts = 0;
    
    // Трекінг ліквідацій для кожної монети
    // Формат: { 'ADAUSDT': [{ amount: 5000, timestamp: 1234567890 }, ...] }
    this.liquidations = new Map();
    
    // Час останнього сповіщення (щоб не спамити)
    this.lastAlert = new Map();
    this.ALERT_COOLDOWN = 60000; // 1 хвилина між повідомленнями про ту саму монету
  }

  async start() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  BINANCE LIQUIDATION MONITOR');
    console.log('═══════════════════════════════════════════════════════');
    console.log('[CONFIG] Поріг ліквідацій:', `$${this.config.LIQUIDATION_THRESHOLD.toLocaleString()}`);
    console.log('[CONFIG] Часове вікно:', `${this.config.TIME_WINDOW_MINUTES} хв`);
    console.log('[CONFIG] Монети:', this.config.SYMBOLS.join(', '));
    console.log('═══════════════════════════════════════════════════════\n');

    // Ініціалізація Telegram бота
    if (this.config.TELEGRAM_BOT_TOKEN && this.config.TELEGRAM_CHAT_ID) {
      this.bot = new TelegramBot(this.config.TELEGRAM_BOT_TOKEN, { polling: false });
      console.log('[TELEGRAM] ✅ Бот ініціалізовано');
    } else {
      console.warn('[TELEGRAM] ⚠️  Telegram не налаштовано (немає токену або chat_id)');
    }

    // Ініціалізація трекерів для кожної монети
    for (const symbol of this.config.SYMBOLS) {
      this.liquidations.set(symbol, []);
    }

    // Підключення до WebSocket
    this.connectWebSocket();

    // Періодичне очищення старих записів
    setInterval(() => this.cleanOldLiquidations(), 60000); // кожну хвилину
  }

  connectWebSocket() {
    try {
      const wsUrl = generateWebSocketURL(this.config.SYMBOLS);
      console.log('[WS] Підключення до Binance WebSocket...');
      console.log('[WS] URL:', wsUrl);
      
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[WS] ✅ Підключено до Binance Liquidation Stream');
        console.log('[WS] Очікування ліквідацій...\n');
        this.reconnectAttempts = 0;
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          // Коли підписані на конкретні стріми, дані приходять у форматі { stream: "...", data: {...} }
          if (message.data) {
            this.handleLiquidation(message.data);
          }
        } catch (error) {
          console.error('[WS] Помилка обробки повідомлення:', error.message);
        }
      });

      this.ws.on('error', (error) => {
        console.error('[WS] Помилка:', error.message);
      });

      this.ws.on('close', () => {
        console.log('[WS] З\'єднання закрито. Перепідключення...');
        this.reconnect();
      });

    } catch (error) {
      console.error('[WS] Помилка підключення:', error.message);
      this.reconnect();
    }
  }

  reconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(this.config.RECONNECT_DELAY * this.reconnectAttempts, 60000);
    
    console.log(`[WS] Спроба перепідключення #${this.reconnectAttempts} через ${delay / 1000}с...`);
    
    setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  handleLiquidation(message) {
    const { o } = message;
    if (!o) return;

    const symbol = o.s; // BTCUSDT
    const side = o.S; // BUY/SELL
    const price = parseFloat(o.p);
    const quantity = parseFloat(o.q);
    const amount = price * quantity; // USD value
    const timestamp = o.T;

    // Додаємо ліквідацію до списку (перевірка не потрібна, бо ми підписані тільки на наші монети)
    const liquidationsList = this.liquidations.get(symbol);
    if (!liquidationsList) {
      // На всяк випадок створюємо, якщо немає
      this.liquidations.set(symbol, []);
      return;
    }
    
    liquidationsList.push({
      amount,
      timestamp,
      side,
      price,
      quantity
    });

    // Логування ліквідації
    const sideEmoji = side === 'BUY' ? '🟢' : '🔴';
    console.log(`[LIQ] ${sideEmoji} ${symbol} | $${amount.toFixed(0)} | ${side}`);

    // Перевіряємо чи досягли порогу
    this.checkThreshold(symbol);
  }

  checkThreshold(symbol) {
    const now = Date.now();
    const timeWindowMs = this.config.TIME_WINDOW_MINUTES * 60 * 1000;
    const liquidationsList = this.liquidations.get(symbol);

    // Фільтруємо лише ліквідації за останні N хвилин
    const recentLiquidations = liquidationsList.filter(
      liq => (now - liq.timestamp) <= timeWindowMs
    );

    // Рахуємо загальну суму
    const totalAmount = recentLiquidations.reduce((sum, liq) => sum + liq.amount, 0);

    // Перевіряємо поріг
    if (totalAmount >= this.config.LIQUIDATION_THRESHOLD) {
      // Перевіряємо cooldown
      const lastAlertTime = this.lastAlert.get(symbol) || 0;
      if ((now - lastAlertTime) < this.ALERT_COOLDOWN) {
        return; // Ще не пройшов cooldown
      }

      // Відправляємо сповіщення
      this.sendAlert(symbol, totalAmount, recentLiquidations);

      // Очищаємо список для цієї монети
      this.liquidations.set(symbol, []);
      this.lastAlert.set(symbol, now);
    }
  }

  async sendAlert(symbol, totalAmount, liquidations) {
    const longLiqs = liquidations.filter(l => l.side === 'BUY');
    const shortLiqs = liquidations.filter(l => l.side === 'SELL');
    
    const longTotal = longLiqs.reduce((sum, l) => sum + l.amount, 0);
    const shortTotal = shortLiqs.reduce((sum, l) => sum + l.amount, 0);

    const message = `
🚨 <b>LIQUIDATION ALERT</b> 🚨

💎 <b>${symbol}</b>
━━━━━━━━━━━━━━━━━━━━
💰 Загалом: <b>$${totalAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>
⏱ За останні: <b>${this.config.TIME_WINDOW_MINUTES} хв</b>

📊 Деталі:
🟢 Long: $${longTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${longLiqs.length})
🔴 Short: $${shortTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${shortLiqs.length})

📈 Всього ліквідацій: ${liquidations.length}
━━━━━━━━━━━━━━━━━━━━
⏰ ${new Date().toLocaleString('uk-UA')}
    `.trim();

    console.log('\n' + '═'.repeat(50));
    console.log('🚨 ALERT TRIGGERED:', symbol);
    console.log(`💰 Total: $${totalAmount.toFixed(0)}`);
    console.log('═'.repeat(50) + '\n');

    // Відправка в Telegram
    if (this.bot && this.config.TELEGRAM_CHAT_ID) {
      try {
        await this.bot.sendMessage(this.config.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
        console.log('[TELEGRAM] ✅ Повідомлення відправлено');
      } catch (error) {
        console.error('[TELEGRAM] ❌ Помилка відправки:', error.message);
      }
    }
  }

  cleanOldLiquidations() {
    const now = Date.now();
    const timeWindowMs = this.config.TIME_WINDOW_MINUTES * 60 * 1000;

    for (const [symbol, liquidationsList] of this.liquidations.entries()) {
      const filtered = liquidationsList.filter(
        liq => (now - liq.timestamp) <= timeWindowMs
      );
      this.liquidations.set(symbol, filtered);
    }
  }

  stop() {
    console.log('\n[APP] Зупинка бота...');
    if (this.ws) {
      this.ws.close();
    }
    if (this.bot) {
      this.bot.stopPolling();
    }
    process.exit(0);
  }
}

// ============================================================================
// ЗАПУСК
// ============================================================================

const monitor = new LiquidationMonitor(CONFIG);

monitor.start().catch(error => {
  console.error('[ERROR] Критична помилка:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => monitor.stop());
process.on('SIGTERM', () => monitor.stop());
