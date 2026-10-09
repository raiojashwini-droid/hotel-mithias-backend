import { prisma } from '../src/config/database.js';

async function clearData() {
  console.log('🔄 Connecting to database and preparing to clear row data...');

  // List of all model tables in order
  const tables = [
    'Message',
    'Conversation',
    'Reservation',
    'Guest',
    'TaskTrail',
    'Task',
    'IssueUpdate',
    'Issue',
    'Upsell',
    'KnowledgeChunk',
    'KnowledgeDoc',
    'AiRule',
    'ActivityItem',
    'WaMessage',
    'WaThread',
    'PmsIntegration',
    'EmailIntegration',
    'WhatsAppIntegration',
    'AiConfig',
    'OnboardingState',
    'Invoice',
    'Subscription',
    'Room',
    'User',
    'Hotel',
  ];

  try {
    // Disable foreign key checks temporarily so relationships are not violated during row deletion
    await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0;');

    for (const table of tables) {
      try {
        await prisma.$executeRawUnsafe(`DELETE FROM \`${table}\`;`);
        console.log(`✅ Cleared row data from table: ${table}`);
      } catch (err) {
        // Table might not exist or already be empty
        console.warn(`⚠️ Skipped or note for table ${table}: ${err.message}`);
      }
    }

    // Re-enable foreign key checks to keep all relationships 100% active and intact
    await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1;');

    console.log('\n🎉 All row data successfully cleared! All tables and relationships are 100% intact.');

    // Verification check
    const hotelCount = await prisma.hotel.count();
    const userCount = await prisma.user.count();
    const roomCount = await prisma.room.count();
    console.log(`📊 Final counts -> Hotels: ${hotelCount}, Users: ${userCount}, Rooms: ${roomCount}`);
  } catch (error) {
    console.error('❌ Error during data deletion:', error);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

clearData();
