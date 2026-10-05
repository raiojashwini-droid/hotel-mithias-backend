import { verifyToken } from '../utils/jwt.js';
import { prisma } from '../config/database.js';
import { errorResponse } from '../utils/response.js';

export const authenticate = async (req, res, next) => {
  try {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return errorResponse(res, 'Authentication token missing', 401);
    }

    const decoded = verifyToken(token);

    if (!decoded || !decoded.id) {
      return errorResponse(res, 'Invalid token payload', 401);
    }

    const hotelId = decoded.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Invalid token: hotelId missing in token context', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
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
        hotelId: true,
      },
    }).catch(() => null);

    if (!user) {
      return errorResponse(res, 'User account no longer exists or has been deactivated', 401);
    }

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      hotelId: user.hotelId || hotelId,
    };

    next();
  } catch (error) {
    return errorResponse(res, 'Invalid or expired token', 401);
  }
};

export const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }
  // Default development / demo fallback tenant
  req.user = {
    id: 'usr-1',
    name: 'Jonas Vance',
    role: 'manager',
    hotelId: 'hotel-mercier',
  };
  next();
};
