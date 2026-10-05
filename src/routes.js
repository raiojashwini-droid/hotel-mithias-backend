import { Router } from 'express';
import authRoutes from './modules/auth/authRoutes.js';
import roomsRoutes from './modules/rooms/roomsRoutes.js';
import knowledgeRoutes from './modules/knowledge/knowledgeRoutes.js';
import tasksRoutes from './modules/tasks/tasksRoutes.js';
import issuesRoutes from './modules/issues/issuesRoutes.js';
import conversationsRoutes from './modules/conversations/conversationsRoutes.js';
import managerRoutes from './modules/manager/managerRoutes.js';
import upsellsRoutes from './modules/upsells/upsellsRoutes.js';
import whatsappRoutes from './modules/whatsapp/whatsappRoutes.js';
import onboardingRoutes from './modules/onboarding/onboardingRoutes.js';
import { handleEmailDetect } from './modules/onboarding/onboardingController.js';
import usersRoutes from './modules/users/userRoutes.js';
import billingRoutes from './modules/billing/billingRoutes.js';
import pmsRoutes from './modules/pms/pmsRoutes.js';
import realtimeRoutes from './modules/realtime/realtimeRoutes.js';
import emailRoutes from './modules/email/emailRoutes.js';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'hotelogx-connect-backend', timestamp: new Date().toISOString() });
});

router.get('/health-diag', async (req, res) => {
  try {
    const { prisma } = await import('./config/database.js');
    const cols = await prisma.$queryRawUnsafe('SHOW COLUMNS FROM EmailIntegration;').catch((e) => e.message);
    const dbUrl = (process.env.DATABASE_URL || '').replace(/:[^:@]+@/, ':***@');
    res.json({
      dbUrl,
      columns: Array.isArray(cols) ? cols.map((c) => c.Field) : cols,
      env: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/email-detect', handleEmailDetect);

router.use('/auth', authRoutes);
router.use('/rooms', roomsRoutes);
router.use('/tasks', tasksRoutes);
router.use('/issues', issuesRoutes);
router.use('/conversations', conversationsRoutes);
router.use('/manager', managerRoutes);
router.use('/upsells', upsellsRoutes);
router.use('/whatsapp', whatsappRoutes);
router.use('/onboarding', onboardingRoutes);
router.use('/knowledge', knowledgeRoutes);
router.use('/users', usersRoutes);
router.use('/billing', billingRoutes);
router.use('/pms', pmsRoutes);
router.use('/realtime', realtimeRoutes);
router.use('/email', emailRoutes);

export default router;
