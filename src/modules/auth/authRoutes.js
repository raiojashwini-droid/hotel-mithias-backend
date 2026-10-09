import { Router } from 'express';
import { login, register, refreshToken, getMe, getStaffList } from './authController.js';
import { authenticate } from '../../middlewares/auth.js';

const router = Router();

router.post('/login', login);
router.post('/register', register);
router.post('/refresh', refreshToken);
router.get('/me', authenticate, getMe);
router.get('/staff', authenticate, getStaffList);

export default router;
