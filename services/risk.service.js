import { config } from '../config/settings.js';
import { roundQuantity, roundPrice, isValidNumber } from '../utils/helpers.js';
import logger from '../utils/logger.js';

/**
 * Розраховує trigger price + limit price для TP і SL на Extended.
 * 
 * На Extended TP/SL виконуються як LIMIT ордери (не market!).
 * Це дає savings на maker fees (0% maker vs 0.025% taker).
 * 
 * Логіка буферів:
 *   LONG TP:  triggerPrice = entry * (1 + tpPercent%)
 *             limitPrice  = trigger * (1 + buffer%)  ← чуть выше, гарантия fill
 *   LONG SL:  triggerPrice = entry * (1 - slPercent%)
 *             limitPrice  = trigger * (1 - buffer%)  ← чуть ниже
 *   SHORT TP: triggerPrice = entry * (1 - tpPercent%)
 *             limitPrice  = trigger * (1 - buffer%)
 *   SHORT SL: triggerPrice = entry * (1 + slPercent%)
 *             limitPrice  = trigger * (1 + buffer%)
 * 
 * @param {number} entryPrice
 * @param {string} direction — 'LONG' | 'SHORT'
 * @param {number} tpPercent — Take Profit % от entry
 * @param {number} slPercent — Stop Loss % от entry
 * @param {number} [pricePrecision=4] — кол-во знаков после запятой
 * @returns {{ tp: { triggerPrice, limitPrice }, sl: { triggerPrice, limitPrice } }}
 */
export function calculateTPSLPrices(entryPrice, direction, tpPercent, slPercent, pricePrecision = 4) {
  const bufferPercent = config.risk.tpSlLimitBuffer || 0.05; // 0.05% по умолчанию
  const bufferFactor = bufferPercent / 100;

  let tpTrigger, tpLimit, slTrigger, slLimit;

  if (direction === 'LONG') {
    // TP: цена растёт → trigger выше entry, limit чуть выше trigger (гарантия fill как maker)
    tpTrigger = entryPrice * (1 + tpPercent / 100);
    tpLimit   = tpTrigger * (1 + bufferFactor);

    // SL: цена падает → trigger ниже entry, limit чуть ниже trigger
    slTrigger = entryPrice * (1 - slPercent / 100);
    slLimit   = slTrigger * (1 - bufferFactor);
  } else {
    // SHORT TP: цена падает → trigger ниже entry, limit чуть ниже trigger
    tpTrigger = entryPrice * (1 - tpPercent / 100);
    tpLimit   = tpTrigger * (1 - bufferFactor);

    // SHORT SL: цена растёт → trigger выше entry, limit чуть выше trigger
    slTrigger = entryPrice * (1 + slPercent / 100);
    slLimit   = slTrigger * (1 + bufferFactor);
  }

  return {
    tp: {
      triggerPrice: roundPrice(tpTrigger, pricePrecision),
      limitPrice:   roundPrice(tpLimit, pricePrecision)
    },
    sl: {
      triggerPrice: roundPrice(slTrigger, pricePrecision),
      limitPrice:   roundPrice(slLimit, pricePrecision)
    }
  };
}

/**
 * Розраховує параметри позиції на основі risk management правил.
 * 
 * Адаптация от Bybit:
 * - symbolInfo теперь содержит minOrderSize, maxPositionValue от Extended
 * - Возвращает tp/sl в формате Extended (triggerPrice + limitPrice)
 * 
 * @param {number} balance — available balance
 * @param {number} entryPrice — текущая цена
 * @param {string} direction — 'LONG' | 'SHORT'
 * @param {Object} marketInfo — от extendedService.getMarketInfo()
 * @returns {Object} параметры позиции
 */
export function calculatePositionParameters(balance, entryPrice, direction, marketInfo = {}) {
  try {
    // Валідація
    if (!isValidNumber(balance) || balance <= 0) {
      throw new Error(`Invalid balance: ${balance}`);
    }
    if (!isValidNumber(entryPrice) || entryPrice <= 0) {
      throw new Error(`Invalid entry price: ${entryPrice}`);
    }
    if (direction !== 'LONG' && direction !== 'SHORT') {
      throw new Error(`Invalid direction: ${direction}. Must be LONG or SHORT`);
    }

    const leverage = config.risk.leverage;
    const pricePrecision = marketInfo.pricePrecision || 4;
    const minOrderSize = marketInfo.minOrderSize || 0.001;
    const maxPositionValue = marketInfo.maxPositionValue || 10000000;

    // 1. Risk в USD
    const riskAmount = balance * (config.risk.percentage / 100);
    logger.info(`[RISK] Balance: ${balance}, Risk: ${config.risk.percentage}% = ${riskAmount}`);

    // 2. Stop Loss distance (в ціні)
    const slPercent = config.risk.stopLossPercent; // 0.3
    const stopLossDistance = entryPrice * (slPercent / 100);

    if (stopLossDistance <= 0) {
      throw new Error('Stop loss distance is zero');
    }

    // 3. Position size (в USD notional)
    //    positionSize = (riskAmount / stopLossDistance) * entryPrice
    let positionSize = (riskAmount / stopLossDistance) * entryPrice;

    // 4. Required margin
    let requiredMargin = positionSize / leverage;

    // Якщо margin > balance → зменшуємо позицію до max доступного
    if (requiredMargin > balance) {
      logger.warn(`[RISK] Required margin (${requiredMargin}) > balance (${balance}). Capping.`);
      positionSize = balance * leverage;
      requiredMargin = balance;
    }

    // 5. Перевірка maxPositionValue
    if (positionSize > maxPositionValue) {
      logger.warn(`[RISK] Position size (${positionSize}) > maxPositionValue (${maxPositionValue}). Capping.`);
      positionSize = maxPositionValue;
      requiredMargin = positionSize / leverage;
    }

    // 6. Quantity (base asset)
    let quantity = positionSize / entryPrice;

    // 7. Round quantity
    const tickSize = marketInfo.tickSize || 0.001;
    quantity = roundQuantity(quantity, tickSize);

    // 8. Перевірка minOrderSize
    if (quantity < minOrderSize) {
      logger.warn(`[RISK] Quantity (${quantity}) < minOrderSize (${minOrderSize}). Using min.`);
      quantity = minOrderSize;
      positionSize = quantity * entryPrice;
    }

    // 9. Фінальна перевірка маржі
    const finalRequiredMargin = (quantity * entryPrice) / leverage;
    if (finalRequiredMargin > balance) {
      throw new Error(`Insufficient balance. Required: ${finalRequiredMargin}, Available: ${balance}`);
    }

    // 10. TP / SL цены (Extended LIMIT формат)
    const tpsl = calculateTPSLPrices(
      entryPrice,
      direction,
      config.risk.takeProfitPercent,
      config.risk.stopLossPercent,
      pricePrecision
    );

    const result = {
      symbol: marketInfo.symbol,
      direction: direction,
      entryPrice: roundPrice(entryPrice, pricePrecision),
      quantity: quantity,
      positionSize: positionSize,
      leverage: leverage,
      requiredMargin: finalRequiredMargin,
      riskAmount: riskAmount,
      // Extended TP/SL формат
      takeProfit: tpsl.tp,       // { triggerPrice, limitPrice }
      stopLoss: tpsl.sl          // { triggerPrice, limitPrice }
    };

    logger.info(`[RISK] Position: qty=${quantity} @ ${result.entryPrice}, margin=${finalRequiredMargin}`);
    logger.info(`[RISK] TP: trigger=${tpsl.tp.triggerPrice}, limit=${tpsl.tp.limitPrice}`);
    logger.info(`[RISK] SL: trigger=${tpsl.sl.triggerPrice}, limit=${tpsl.sl.limitPrice}`);

    return result;
  } catch (error) {
    logger.error(`[RISK] Error calculating position parameters: ${error.message}`);
    throw error;
  }
}

/**
 * Перевіряє чи достатньо балансу
 */
export function hasSufficientBalance(balance, requiredMargin) {
  return isValidNumber(balance) && isValidNumber(requiredMargin) && balance >= requiredMargin;
}

export default {
  calculatePositionParameters,
  calculateTPSLPrices,
  hasSufficientBalance
};
