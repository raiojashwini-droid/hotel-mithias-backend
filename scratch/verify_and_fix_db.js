import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Connecting to Railway Database...');
  
  // Query existing columns in EmailIntegration table
  const rawCols = await prisma.$queryRawUnsafe(`SHOW COLUMNS FROM EmailIntegration;`);
  console.log('Current columns in EmailIntegration:', rawCols.map(c => c.Field));

  const existingFields = rawCols.map(c => c.Field);
  const requiredCols = [
    { name: 'accessToken', type: 'TEXT NULL' },
    { name: 'refreshToken', type: 'TEXT NULL' },
    { name: 'tokenExpiry', type: 'DATETIME(3) NULL' },
    { name: 'scope', type: 'TEXT NULL' },
    { name: 'historyId', type: 'VARCHAR(191) NULL' },
    { name: 'lastSyncAt', type: 'DATETIME(3) NULL' },
    { name: 'imapHost', type: 'VARCHAR(191) NULL' },
    { name: 'imapPort', type: 'INT NULL' },
    { name: 'smtpHost', type: 'VARCHAR(191) NULL' },
    { name: 'smtpPort', type: 'INT NULL' },
  ];

  for (const col of requiredCols) {
    if (!existingFields.includes(col.name)) {
      try {
        console.log(`Adding missing column ${col.name}...`);
        await prisma.$executeRawUnsafe(`ALTER TABLE EmailIntegration ADD COLUMN ${col.name} ${col.type};`);
        console.log(`✅ Added ${col.name}`);
      } catch (err) {
        console.error(`Failed to add ${col.name}:`, err.message);
      }
    } else {
      console.log(`✔ Column ${col.name} is already present.`);
    }
  }

  const updatedCols = await prisma.$queryRawUnsafe(`SHOW COLUMNS FROM EmailIntegration;`);
  console.log('Updated EmailIntegration Columns:', updatedCols.map(c => c.Field));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
