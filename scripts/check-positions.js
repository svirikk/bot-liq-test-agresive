// .env загружается автоматически в config/settings.js (через extended.service.js)
import extendedService from '../services/extended.service.js';
import logger from '../utils/logger.js';

async function checkPositions() {
  try {
    logger.info('Checking Extended.exchange positions...');
    
    await extendedService.connect();
    const positions = await extendedService.getPositions();
    
    console.log('\n' + '='.repeat(50));
    
    if (positions.length === 0) {
      console.log('📊 No open positions');
    } else {
      console.log(`📊 Open Positions: ${positions.length}\n`);
      
      positions.forEach((pos, index) => {
        const direction = pos.side === 'BUY' ? 'LONG' : 'SHORT';
        console.log(`Position ${index + 1}:`);
        console.log(`  Symbol:      ${pos.symbol}`);
        console.log(`  Direction:   ${direction}`);
        console.log(`  Size:        ${pos.size}`);
        console.log(`  Entry Price: $${pos.entryPrice.toFixed(4)}`);
        console.log(`  Mark Price:  $${pos.markPrice.toFixed(4)}`);
        console.log(`  Unrealised P&L: ${pos.unrealisedPnl >= 0 ? '+' : ''}$${pos.unrealisedPnl.toFixed(2)}`);
        console.log(`  Leverage:    ${pos.leverage}x`);
        console.log('');
      });
    }
    
    console.log('='.repeat(50) + '\n');
    
    process.exit(0);
  } catch (error) {
    logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

checkPositions();
