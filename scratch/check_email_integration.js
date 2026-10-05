import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const integrations = await prisma.emailIntegration.findMany();
  console.log('--- EMAIL INTEGRATIONS IN DB ---');
  console.log(integrations.map(i => ({
    id: i.id,
    hotelId: i.hotelId,
    email: i.email,
    provider: i.provider,
    hasToken: Boolean(i.accessToken),
    status: i.status
  })));
}

main().finally(() => prisma.$disconnect());
