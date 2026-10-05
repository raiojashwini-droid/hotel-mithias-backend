import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { getSubscription, updateSubscription, getInvoices } from './billingController.js';

const router = Router();

router.get('/subscription', authenticate, getSubscription);
router.put('/subscription', authenticate, updateSubscription);
router.get('/invoices', authenticate, getInvoices);

export default router;
