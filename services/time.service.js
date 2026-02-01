import { config } from '../config/settings.js';
import logger from '../utils/logger.js';

/**
 * Перевіряє чи активні торговельні години
 * @returns {boolean} true якщо торговельні години активні
 */
export function isTradingHoursActive() {
  if (!config.tradingHours.enabled) {
    return true;
  }

  const now = new Date();
  const currentHour = now.getUTCHours(); // Завжди використовуємо UTC
  
  const startHour = config.tradingHours.startHour;
  const endHour = config.tradingHours.endHour;
  
  // Обробка випадку коли endHour < startHour (наприклад, 22:00 - 06:00)
  let isActive;
  if (endHour > startHour) {
    isActive = currentHour >= startHour && currentHour < endHour;
  } else {
    // Перехід через півночь
    isActive = currentHour >= startHour || currentHour < endHour;
  }
  
  if (!isActive) {
    logger.info(
      `[TIME] Outside trading hours. Current: ${currentHour}:00 UTC, ` +
      `Allowed: ${startHour}:00-${endHour}:00 UTC`
    );
  }
  
  return isActive;
}

/**
 * Отримує інформацію про торговельні години
 * @returns {Object} інформація про поточний стан та наступний торговий період
 */
export function getTradingHoursInfo() {
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  
  const startHour = config.tradingHours.startHour;
  const endHour = config.tradingHours.endHour;
  
  const isActive = isTradingHoursActive();
  
  // Розрахунок часу до наступного торгового періоду
  let nextTradingIn = null;
  if (!isActive) {
    let nextStart = new Date(now);
    nextStart.setUTCHours(startHour, 0, 0, 0);
    
    if (endHour > startHour) {
      // Якщо поточний час після endHour, наступний старт - завтра
      if (currentHour >= endHour) {
        nextStart.setUTCDate(nextStart.getUTCDate() + 1);
      }
    } else {
      // Перехід через півночь
      if (currentHour < startHour) {
        // Вже сьогодні
      } else {
        nextStart.setUTCDate(nextStart.getUTCDate() + 1);
      }
    }
    
    const diffMs = nextStart - now;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    nextTradingIn = `${diffHours}h ${diffMinutes}m`;
  }
  
  return {
    isActive,
    currentHour,
    currentMinute,
    startHour,
    endHour,
    timezone: config.tradingHours.timezone,
    nextTradingIn
  };
}

/**
 * Форматує повідомлення про торговельні години
 */
export function formatTradingHoursMessage() {
  const info = getTradingHoursInfo();
  const now = new Date();
  const currentTime = `${String(info.currentHour).padStart(2, '0')}:${String(info.currentMinute).padStart(2, '0')}`;
  
  if (info.isActive) {
    return `✅ Trading hours active\nCurrent time: ${currentTime} UTC\nTrading hours: ${info.startHour}:00-${info.endHour}:00 UTC`;
  } else {
    return `⏰ Trading hours inactive\nCurrent time: ${currentTime} UTC\nTrading hours: ${info.startHour}:00-${info.endHour}:00 UTC\nNext trading: in ${info.nextTradingIn}`;
  }
}

export default {
  isTradingHoursActive,
  getTradingHoursInfo,
  formatTradingHoursMessage
};
