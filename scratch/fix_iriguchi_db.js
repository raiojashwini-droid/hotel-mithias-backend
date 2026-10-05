import { PrismaClient } from '@prisma/client';

// Connect explicitly to iriguchi Railway DB
const dbUrl = "mysql://root:NcuZFFIgfFbzMuqrGzmTUhHGrZsQMOGR@iriguchi.proxy.rlwy.net:12031/railway";
const prisma = new PrismaClient({
  datasources: {
    db: { url: dbUrl }
  }
});

async function main() {
  console.log('Connecting to iriguchi.proxy.rlwy.net:12031...');
  
  const rawCols = await prisma.$queryRawUnsafe(`SHOW COLUMNS FROM EmailIntegration;`);
  const existingFields = rawCols.map(c => c.Field);
  console.log('Current iriguchi columns:', existingFields);

  const requiredCols = [
    { name: 'accessToken', type: 'TEXT NULL' },
    { name: 'refreshToken', type: 'TEXT NULL' },
    { name: 'tokenExpiry', type: 'DATETIME(3) NULL' },
    { name: 'scope', type: 'TEXT NULL' },
    { name: 'historyId', type: 'VARCHAR(191) NULL' },
    { name: 'lastSyncAt', type: 'DATETIME(3) NULL' },
  ];

  for (const col of requiredCols) {
    if (!existingFields.includes(col.name)) {
      try {
        console.log(`Adding column ${col.name} to iriguchi DB...`);
        await prisma.$executeRawUnsafe(`ALTER TABLE EmailIntegration ADD COLUMN ${col.name} ${col.type};`);
        console.log(`✅ Added ${col.name}`);
      } catch (err) {
        console.error(`Failed adding ${col.name}:`, err.message);
      }
    } else {
      console.log(`✔ Column ${col.name} already exists on iriguchi DB.`);
    }
  }

  const updatedCols = await prisma.$queryRawUnsafe(`SHOW COLUMNS FROM EmailIntegration;`);
  console.log('Updated iriguchi EmailIntegration Columns:', updatedCols.map(c => c.Field));
}

main().catch(console.error).finally(() => prisma.$disconnect());
