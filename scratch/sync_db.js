import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Connecting to Railway DB...');
  try {
    // Add columns to EmailIntegration if missing
    const columns = [
      "ADD COLUMN accessToken TEXT NULL",
      "ADD COLUMN refreshToken TEXT NULL",
      "ADD COLUMN tokenExpiry DATETIME(3) NULL",
      "ADD COLUMN scope TEXT NULL",
      "ADD COLUMN historyId VARCHAR(191) NULL",
      "ADD COLUMN lastSyncAt DATETIME(3) NULL",
      "ADD COLUMN imapHost VARCHAR(191) NULL",
      "ADD COLUMN imapPort INT NULL",
      "ADD COLUMN smtpHost VARCHAR(191) NULL",
      "ADD COLUMN smtpPort INT NULL",
    ];

    for (const col of columns) {
      try {
        await prisma.$executeRawUnsafe(`ALTER TABLE EmailIntegration ${col}`);
        console.log(`Successfully added: ${col}`);
      } catch (err) {
        if (err.message.includes('Duplicate column') || err.message.includes('already exists')) {
          console.log(`Column already exists: ${col}`);
        } else {
          console.warn(`Warning for ${col}:`, err.message);
        }
      }
    }
    console.log('Database sync complete!');
  } catch (err) {
    console.error('Migration script failed:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
