// .env загружается автоматически в config/settings.js (через extended.service.js)
import extendedService from '../services/extended.service.js';
import logger from '../utils/logger.js';

async function checkBalance() {
  try {
    logger.info('Checking Extended.exchange balance...');
    
    await extendedService.connect();
    const balance = await extendedService.getBalance();
    
    console.log('\n' + '='.repeat(50));
    console.log(`💰 Balance: ${balance.toFixed(2)}`);
    console.log('='.repeat(50) + '\n');
    
    process.exit(0);
  } catch (error) {
    logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

checkBalance();
