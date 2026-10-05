import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { getUsers, inviteUser, updateUserRole, deleteUser } from './userController.js';

const router = Router();

router.get('/', authenticate, getUsers);
router.post('/invite', authenticate, inviteUser);
router.put('/:id/role', authenticate, updateUserRole);
router.delete('/:id', authenticate, deleteUser);

export default router;
