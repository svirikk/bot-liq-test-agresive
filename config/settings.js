import dotenv from 'dotenv';

dotenv.config();

// Валідація обов'язкових змінних
const requiredEnvVars = [
  'EXTENDED_API_KEY',
  'EXTENDED_STARK_PRIVATE_KEY',
  'EXTENDED_STARK_PUBLIC_KEY',
  'EXTENDED_VAULT_ID',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHANNEL_ID'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

export const config = {
  // Extended.exchange API
  extended: {
    apiKey: process.env.EXTENDED_API_KEY,
    starkPrivateKey: process.env.EXTENDED_STARK_PRIVATE_KEY,
    starkPublicKey: process.env.EXTENDED_STARK_PUBLIC_KEY,
    vaultId: process.env.EXTENDED_VAULT_ID,
    baseURL: process.env.EXTENDED_BASE_URL || 'https://api.starknet.extended.exchange/api/v1',
    wsURL: process.env.EXTENDED_WS_URL || 'wss://api.starknet.extended.exchange/stream.extended.exchange/v1',
    userAgent: 'ExtendedTradingBot/1.0'
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    channelId: process.env.TELEGRAM_CHANNEL_ID
  },

  // Risk Management
  risk: {
    percentage: parseFloat(process.env.RISK_PERCENTAGE || '2.5'),
    leverage: parseInt(process.env.LEVERAGE || '20'),
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT || '0.5'),
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT || '0.3'),
    // Buffer для LIMIT TP/SL ордерів (відсотки від trigger)
    tpSlLimitBuffer: parseFloat(process.env.TPSL_LIMIT_BUFFER || '0.05') // 0.05%
  },

  // Trading Settings
  trading: {
    // Символи на Extended у форматі: BTC-USD, ETH-USD
    allowedSymbols: (process.env.ALLOWED_SYMBOLS || 'BTC-USD,ETH-USD,SOL-USD').split(',').map(s => s.trim()),
    maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || '20'),
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '3'),
    dryRun: process.env.DRY_RUN === 'true'
  },

  // Trading Hours (UTC)
  tradingHours: {
    enabled: process.env.TRADING_HOURS_ENABLED === 'true',
    startHour: parseInt(process.env.TRADING_START_HOUR || '6'),
    endHour: parseInt(process.env.TRADING_END_HOUR || '22'),
    timezone: process.env.TIMEZONE || 'UTC'
  },

  // Extended-specific constants
  extendedConst: {
    // Maker fee (все ордери — entry, TP, SL — теперь LIMIT GTT)
    makerFee: '0.00000',        // 0% maker rebate
    // Буфер entry LIMIT ордера від best bid/ask.
    // BUY  → price = bestAsk + buffer   (чуть выше ask → гарантия fill как maker)
    // SELL → price = bestBid - buffer   (чуть ниже bid)
    // Тот же буфер что и для TP/SL limit цен — 0.05%.
    entryLimitBuffer: 0.0005,   // 0.05%
    // Max expiry: 90 днів в мілісекундах
    maxExpiryMs: 90 * 24 * 60 * 60 * 1000
  }
};

// Валідація конфігурації
if (config.risk.percentage <= 0 || config.risk.percentage > 100) {
  throw new Error('RISK_PERCENTAGE must be between 0 and 100');
}

if (config.risk.leverage <= 0 || config.risk.leverage > 100) {
  throw new Error('LEVERAGE must be between 1 and 100');
}

if (config.trading.maxDailyTrades <= 0) {
  throw new Error('MAX_DAILY_TRADES must be greater than 0');
}

if (config.trading.maxOpenPositions <= 0) {
  throw new Error('MAX_OPEN_POSITIONS must be greater than 0');
}

if (config.tradingHours.startHour < 0 || config.tradingHours.startHour > 23) {
  throw new Error('TRADING_START_HOUR must be between 0 and 23');
}

if (config.tradingHours.endHour < 0 || config.tradingHours.endHour > 23) {
  throw new Error('TRADING_END_HOUR must be between 0 and 23');
}

export default config;
