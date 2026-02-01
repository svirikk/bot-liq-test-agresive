/**
 * Округлює число до певної кількості знаків після коми
 */
export function roundToDecimal(value, decimals) {
  if (isNaN(value) || value === null || value === undefined) {
    return 0;
  }
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Округлює quantity згідно з вимогами біржі (tickSize)
 */
export function roundQuantity(quantity, tickSize) {
  if (!tickSize || tickSize <= 0) return quantity;
  
  const precision = Math.abs(Math.log10(tickSize));
  return roundToDecimal(quantity, precision);
}

/**
 * Округлює ціну згідно з вимогами біржі (pricePrecision)
 */
export function roundPrice(price, pricePrecision) {
  if (pricePrecision === undefined || pricePrecision === null) {
    return roundToDecimal(price, 8);
  }
  return roundToDecimal(price, pricePrecision);
}

/**
 * Перевіряє чи є значення валідним числом
 */
export function isValidNumber(value) {
  return typeof value === 'number' && !isNaN(value) && isFinite(value) && value > 0;
}

/**
 * Форматує число для виводу (з комами для тисяч)
 */
export function formatNumber(num, decimals = 2) {
  if (!isValidNumber(num)) return '0.00';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

/**
 * Форматує відсоток
 */
export function formatPercent(value, decimals = 2) {
  if (!isValidNumber(value)) return '0.00%';
  return `${value.toFixed(decimals)}%`;
}

/**
 * Обчислює P&L у відсотках
 */
export function calculatePnLPercent(entryPrice, exitPrice, direction) {
  if (!isValidNumber(entryPrice) || !isValidNumber(exitPrice)) {
    return 0;
  }
  
  if (direction === 'LONG') {
    return ((exitPrice - entryPrice) / entryPrice) * 100;
  } else if (direction === 'SHORT') {
    return ((entryPrice - exitPrice) / entryPrice) * 100;
  }
  
  return 0;
}

/**
 * Обчислює P&L в USD (collateral currency на Extended)
 */
export function calculatePnL(entryPrice, exitPrice, quantity, direction) {
  if (!isValidNumber(entryPrice) || !isValidNumber(exitPrice) || !isValidNumber(quantity)) {
    return 0;
  }
  
  if (direction === 'LONG') {
    return (exitPrice - entryPrice) * quantity;
  } else if (direction === 'SHORT') {
    return (entryPrice - exitPrice) * quantity;
  }
  
  return 0;
}

/**
 * Форматує тривалість часу
 */
export function formatDuration(seconds) {
  if (!isValidNumber(seconds)) return '0s';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  
  return parts.join(' ');
}

/**
 * Перевіряє чи символ в списку дозволених
 * Підтримує формат Extended: BTC-USD, ETH-USD
 */
export function isSymbolAllowed(symbol, allowedSymbols) {
  if (!symbol || !allowedSymbols) return false;
  const symbols = allowedSymbols.split(',').map(s => s.trim().toUpperCase());
  return symbols.includes(symbol.toUpperCase());
}

/**
 * Отримує поточну дату в форматі YYYY-MM-DD
 */
export function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Отримує поточний час UTC
 */
export function getCurrentUTCHour() {
  return new Date().getUTCHours();
}

/**
 * Затримка (sleep)
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
