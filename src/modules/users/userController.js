import { prisma } from '../../config/database.js';
import { successResponse, errorResponse } from '../../utils/response.js';

const VALID_ROLES = ['manager', 'front-office', 'housekeeping', 'maintenance'];

const ROLE_DEFAULT_TITLES = {
  manager: 'Hotel Manager',
  'front-office': 'Front Office Receptionist',
  housekeeping: 'Housekeeping Supervisor',
  maintenance: 'Lead Technician',
};

export const getUsers = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';

    let users = await prisma.user.findMany({
      where: { hotelId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        title: true,
        phone: true,
        initials: true,
        lastActive: true,
        whatsapp: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // If hotel-mercier has users with null hotelId, associate them
    if (users.length === 0 && hotelId === 'hotel-mercier') {
      const existingNulls = await prisma.user.findMany({
        where: { hotelId: null },
      });
      if (existingNulls.length > 0) {
        await prisma.user.updateMany({
          where: { hotelId: null },
          data: { hotelId: 'hotel-mercier' },
        });
        users = await prisma.user.findMany({
          where: { hotelId: 'hotel-mercier' },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            title: true,
            phone: true,
            initials: true,
            lastActive: true,
            whatsapp: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        });
      }
    }

    return successResponse(res, users, 'Users retrieved successfully');
  } catch (error) {
    next(error);
  }
};

export const inviteUser = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Unauthorized - Missing hotel identification', 401);
    }

    const { email, role, name, title, phone, whatsapp } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return errorResponse(res, 'Valid email address is required', 400);
    }

    const cleanRole = role ? role.toLowerCase() : 'front-office';
    if (!VALID_ROLES.includes(cleanRole)) {
      return errorResponse(res, `Invalid role. Allowed roles: ${VALID_ROLES.join(', ')}`, 400);
    }

    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    if (existing) {
      if (existing.hotelId === hotelId) {
        return errorResponse(res, 'A user with this email already exists in your hotel', 409);
      } else {
        return errorResponse(res, 'A user with this email is already registered in another hotel', 409);
      }
    }

    const cleanEmail = email.trim().toLowerCase();
    const fallbackName = name?.trim() || cleanEmail.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const initials = fallbackName
      .split(' ')
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'ST';

    const newUser = await prisma.user.create({
      data: {
        hotelId,
        email: cleanEmail,
        name: fallbackName,
        role: cleanRole,
        title: title?.trim() || ROLE_DEFAULT_TITLES[cleanRole] || 'Staff Member',
        phone: phone?.trim() || '',
        initials,
        lastActive: 'Invited just now',
        whatsapp: whatsapp !== undefined ? Boolean(whatsapp) : true,
        passwordHash: '',
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        title: true,
        phone: true,
        initials: true,
        lastActive: true,
        whatsapp: true,
        createdAt: true,
      },
    });

    return successResponse(res, newUser, 'User invited successfully', 201);
  } catch (error) {
    next(error);
  }
};

export const updateUserRole = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Unauthorized - Missing hotel identification', 401);
    }

    const { id } = req.params;
    const { role } = req.body;

    const cleanRole = role ? role.toLowerCase() : '';
    if (!VALID_ROLES.includes(cleanRole)) {
      return errorResponse(res, `Invalid role. Allowed roles: ${VALID_ROLES.join(', ')}`, 400);
    }

    // Tenant-isolated check
    const user = await prisma.user.findFirst({
      where: { id, hotelId },
    });

    if (!user) {
      return errorResponse(res, 'User not found or access denied', 404);
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { role: cleanRole },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        title: true,
        phone: true,
        initials: true,
        lastActive: true,
        whatsapp: true,
        createdAt: true,
      },
    });

    return successResponse(res, updated, 'User role updated successfully');
  } catch (error) {
    next(error);
  }
};

export const deleteUser = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Unauthorized - Missing hotel identification', 401);
    }

    const { id } = req.params;

    // Tenant-isolated check
    const user = await prisma.user.findFirst({
      where: { id, hotelId },
    });

    if (!user) {
      return errorResponse(res, 'User not found or access denied', 404);
    }

    await prisma.user.delete({
      where: { id },
    });

    return successResponse(res, null, 'User removed successfully');
  } catch (error) {
    next(error);
  }
};
