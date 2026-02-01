import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Створюємо форматтер для логів
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    if (Object.keys(meta).length > 0 && meta.stack) {
      msg += `\n${meta.stack}`;
    } else if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// ✅ Базовий транспорт — console (працює завжди, Railway показує в Logs UI)
const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      logFormat
    )
  })
];

// ✅ File logging ТІЛЬКИ локально (Railway має ephemeral filesystem)
if (process.env.NODE_ENV !== 'production') {
  const logsDir = path.join(__dirname, '../logs');
  
  // Створюємо logs директорію якщо не існує
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  transports.push(
    // Файл для всіх логів
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    // Файл тільки для помилок
    new winston.transports.File({
      filename: path.join(logsDir, 'errors.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  );
}

// Створюємо логер
const logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: transports
});

export default logger;
