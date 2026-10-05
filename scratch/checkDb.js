import { prisma } from '../src/config/database.js';

async function check() {
  try {
    const hotelCols = await prisma.$queryRawUnsafe('SHOW COLUMNS FROM Hotel');
    console.log('Hotel columns:', hotelCols.map(c => c.Field));
    const aiCols = await prisma.$queryRawUnsafe('SHOW COLUMNS FROM AiRule');
    console.log('AiRule columns:', aiCols.map(c => c.Field));
  } catch (e) {
    console.error('Error:', e);
  }
  process.exit(0);
}

check().catch(console.error);
