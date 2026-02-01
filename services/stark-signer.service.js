import { ec } from 'starknet';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';

/**
 * StarkSigner
 * 
 * Відповідь за:
 * - Генерацію Stark EC підписів для ордерів
 * - Створення hash-а з параметрів ордера (pedersen chain)
 * - Генерацію nonce та external order ID
 * 
 * Кожен ордер (entry, TP, SL) потребує окремого підпису.
 */
class StarkSigner {
  constructor() {
    this.privateKey = config.extended.starkPrivateKey;
    this.publicKey = config.extended.starkPublicKey;
    this.vaultId = config.extended.vaultId;

    // Створюємо EC instance з starknet.js
    // ec.sign() приймає (privateKey, msgHash)
    this.ec = ec;

    logger.info('[STARK] StarkSigner initialized');
    logger.info(`[STARK] Public Key: ${this.publicKey.slice(0, 12)}...`);
    logger.info(`[STARK] Vault ID: ${this.vaultId}`);
  }

  /**
   * Генерує nonce: random integer [1, 2^31 - 1]
   * Extended вимога: nonce ≥ 1 і ≤ 2^31
   */
  generateNonce() {
    const max = Math.pow(2, 31) - 1;
    return Math.floor(Math.random() * max) + 1;
  }

  /**
   * Генерує унікальний external order ID
   * Формат: timestamp-random (string)
   */
  generateExternalId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}`;
  }

  /**
   * Створює order hash з параметрів (Pedersen chain).
   * 
   * Extended хеш-структура порядку полів:
   *   market, side, type, qty, price, timeInForce, expiryEpochMillis, fee, nonce, vaultId
   * 
   * Кожне поле конвертується в felt (hex string) і хешується
   * через послідовні вызови pedersen.
   * 
   * NOTE: Точний порядок полів та форматування може потребувати
   * коригування під конкретну версію Extended API.
   * Сверніть увагу на Python SDK reference для валідації.
   */
  getOrderHash(orderParams, nonce) {
    const {
      market,
      side,
      type = 'LIMIT',
      qty,
      price,
      timeInForce = 'GTT',
      expiryEpochMillis,
      fee
    } = orderParams;

    // Конвертуємо кожен елемент в hex felt string
    // Строкові поля → кодуємо через хеш їх ASCII
    const marketFelt = this.stringToFelt(market);
    const sideFelt = this.stringToFelt(side);       // 'BUY' / 'SELL'
    const typeFelt = this.stringToFelt(type);       // 'LIMIT' / 'MARKET' / 'TPSL'
    const tifFelt = this.stringToFelt(timeInForce); // 'GTT' / 'IOC'

    // Числові поля → hex (felt = BigInt → hex string)
    const qtyFelt = this.decimalToFelt(qty);
    const priceFelt = this.decimalToFelt(price);
    const expiryFelt = '0x' + BigInt(expiryEpochMillis).toString(16);
    const feeFelt = this.decimalToFelt(fee);
    const nonceFelt = '0x' + BigInt(nonce).toString(16);
    const vaultFelt = '0x' + BigInt(this.vaultId).toString(16);

    // Pedersen chain: h = pedersen(pedersen(...pedersen(0, field1), field2), ...)
    // Використовуємо starknet.js pedersen
    const { pedersen } = await_import_pedersen();

    let hash = '0x0';
    const fields = [
      marketFelt,
      sideFelt,
      typeFelt,
      qtyFelt,
      priceFelt,
      tifFelt,
      expiryFelt,
      feeFelt,
      nonceFelt,
      vaultFelt
    ];

    for (const field of fields) {
      hash = pedersen(hash, field);
    }

    return hash;
  }

  /**
   * Підписує ордер → повертає { r, s } signature
   * 
   * @param {Object} orderParams — параметри ордера (market, side, qty, price, ...)
   * @param {number} nonce — unique nonce для цього ордера
   * @returns {{ r: string, s: string }} Stark signature
   */
  signOrder(orderParams, nonce) {
    try {
      const msgHash = this.getOrderHash(orderParams, nonce);
      
      // ec.sign(privateKey, msgHash) → { r: BN, s: BN }
      const signature = this.ec.sign(this.privateKey, msgHash);

      const r = '0x' + signature.r.toString(16);
      const s = '0x' + signature.s.toString(16);

      logger.info(`[STARK] Order signed. Nonce: ${nonce}, r: ${r.slice(0, 14)}...`);

      return { r, s };
    } catch (error) {
      logger.error(`[STARK] Error signing order: ${error.message}`);
      throw error;
    }
  }

  /**
   * Формує полний settlement объект для ордера
   */
  buildSettlement(signature) {
    return {
      signature: signature,
      starkKey: this.publicKey,
      collateralPosition: this.vaultId
    };
  }

  /**
   * Підписує і формує settlement для entry + TP + SL за один раз.
   * 
   * @returns {Object} { entry, tp, sl } — кожен містить { nonce, settlement }
   */
  signFullOrder(entryParams, tpParams, slParams) {
    const entryNonce = this.generateNonce();
    const tpNonce = this.generateNonce();
    const slNonce = this.generateNonce();

    const entrySig = this.signOrder(entryParams, entryNonce);
    const tpSig = this.signOrder(tpParams, tpNonce);
    const slSig = this.signOrder(slParams, slNonce);

    return {
      entry: {
        nonce: entryNonce,
        settlement: this.buildSettlement(entrySig)
      },
      tp: {
        nonce: tpNonce,
        settlement: this.buildSettlement(tpSig)
      },
      sl: {
        nonce: slNonce,
        settlement: this.buildSettlement(slSig)
      }
    };
  }

  // ─── Utility: string → felt (简单 keccak / pedersen hash) ───────────

  /**
   * Конвертує short ASCII string в felt.
   * Для полів типу 'BTC-USD', 'BUY', 'SELL', 'LIMIT', 'GTT' / 'IOC'
   * — прості ASCII strings помещаются в felt напрямую через hex encoding.
   */
  stringToFelt(str) {
    if (!str) return '0x0';
    let hex = '';
    for (let i = 0; i < str.length; i++) {
      hex += str.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return '0x' + hex;
  }

  /**
   * Конвертує decimal string (ціна / qty / fee) в felt.
   * Наприклад: "42000.50" → BigInt representation
   * Extended використовує fixed-point: умножаємо на 10^8 і берёмо целую часть.
   */
  decimalToFelt(value) {
    const PRECISION = 8;
    const factor = BigInt(10 ** PRECISION);
    const bigVal = BigInt(Math.round(parseFloat(value) * Number(factor)));
    return '0x' + bigVal.toString(16);
  }
}

/**
 * Lazy import для pedersen function з starknet.js.
 * Вирішує проблему top-level await в ESM модулях.
 */
let _pedersen = null;
function await_import_pedersen() {
  // starknet.js v6 export: import { pedersen } from 'starknet'
  // Якщо доступно — використовуємо. Інакше — fallback stub.
  if (!_pedersen) {
    try {
      // Dynamic import не потрібний — starknet.js v6 export sync
      const starknet = await import('starknet');
      _pedersen = starknet.pedersen || starknet.hash?.pedersen;
    } catch (e) {
      logger.warn('[STARK] pedersen not found in starknet.js, using stub');
      // Stub для DRY_RUN тестування без реальних подписей
      _pedersen = (a, b) => '0x' + BigInt(0x12345678).toString(16);
    }
  }
  return { pedersen: _pedersen };
}

// Singleton
const starkSigner = new StarkSigner();
export default starkSigner;
