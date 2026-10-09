import app from './app.js';
import { config } from './config/env.js';
import { prisma } from './config/database.js';

const PORT = config.port || 5000;

async function startServer() {
  try {
    console.log('⏳ Connecting to Database...');
    await prisma.$connect();
    console.log('✅ Database connected successfully');

    const server = app.listen(PORT, () => {
      console.log(`🚀 Hotelogx Connect Backend listening on port ${PORT}`);
      console.log(`📡 Environment: ${config.nodeEnv}`);
      console.log(`🔗 Hotel check: http://localhost:${PORT}`);
    });

    let mailboxPollInterval = null;
    if (process.env.NODE_ENV !== 'test') {
      const { emailService } = await import('./modules/email/emailService.js');
      mailboxPollInterval = setInterval(async () => {
        try {
          const integrations = await prisma.emailIntegration.findMany({
            where: { status: 'connected' },
            select: { hotelId: true, provider: true },
          });
          for (const integ of integrations) {
            try {
              await emailService.syncHotelInbox(integ.hotelId, 5);
            } catch (_) {}
          }
        } catch (_) {}
      }, 60000);
      if (mailboxPollInterval.unref) mailboxPollInterval.unref();
    }

    const shutdown = async (signal) => {
      console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
      if (mailboxPollInterval) clearInterval(mailboxPollInterval);
      server.close(async () => {
        await prisma.$disconnect();
        console.log('🔌 Database disconnected cleanly.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('\n❌ [FATAL DATABASE ERROR]: Unable to connect to the database on startup!');
    console.error(`💥 Reason: ${error.message}\n`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
}

startServer();
