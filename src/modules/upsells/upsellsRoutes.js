import { Router } from 'express';
import { getUpsells, updateUpsellStatus } from './upsellsController.js';
import { authenticate } from '../../middlewares/auth.js';

const router = Router();

router.get('/', authenticate, getUpsells);
router.patch('/:id/status', authenticate, updateUpsellStatus);

export default router;
