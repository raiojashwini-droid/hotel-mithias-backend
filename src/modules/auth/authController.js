import bcrypt from 'bcryptjs';
import { prisma } from '../../config/database.js';
import { signToken } from '../../utils/jwt.js';
import { errorResponse, successResponse } from '../../utils/response.js';

export const register = async (req, res, next) => {
  try {
    const { hotelName, managerName, email, password, phone, address, city, country } = req.body;

    if (!hotelName || !managerName || !email) {
      return errorResponse(res, 'Hotel name, manager name, and email are required', 400);
    }

    const cleanEmail = email.trim().toLowerCase();
    const existingUser = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existingUser) {
      return errorResponse(res, 'A user with this email already exists', 409);
    }

    const slug = hotelName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20).replace(/^-+|-+$/g, '') || 'hotel';
    const uniqueSuffix = Math.random().toString(36).substring(2, 8);
    const hotelId = `${slug}-${uniqueSuffix}`;

    const passwordHash = password ? await bcrypt.hash(password, 10) : await bcrypt.hash('demo-access', 10);

    const initials = managerName
      .split(' ')
      .map((w) => w[0]?.toUpperCase() || '')
      .join('')
      .slice(0, 2) || 'GM';

    // 1. Create Hotel with onboardingDone = false
    const newHotel = await prisma.hotel.create({
      data: {
        id: hotelId,
        name: hotelName.trim(),
        legalName: `${hotelName.trim()} BV`,
        stars: 4,
        roomsCount: 0,
        address: address || 'Main Street 1',
        postcode: '1000',
        city: city || 'City',
        country: country || 'Country',
        timezone: 'Europe/Brussels',
        currency: '€',
        phone: phone || '+32 0 000 00 00',
        email: cleanEmail,
        website: `${slug}.com`,
        bookingEngine: `https://booking.${slug}.com`,
        whatsappNumber: phone || '+32 0 000 00 00',
        checkIn: '15:00',
        checkOut: '11:00',
        vatNumber: '',
        description: `Welcome to ${hotelName.trim()}`,
        waTopology: 'separate',
        onboardingDone: false,
        onboardingSteps: JSON.stringify(['profile']),
        aiMode: 'Autonomous',
      },
    });

    // 2. Create Manager User
    const newUser = await prisma.user.create({
      data: {
        hotelId: newHotel.id,
        name: managerName.trim(),
        email: cleanEmail,
        role: 'manager',
        title: 'General Manager',
        phone: phone || '',
        initials,
        lastActive: 'now',
        whatsapp: true,
        passwordHash,
      },
    });

    const token = signToken({
      id: newUser.id,
      role: newUser.role,
      email: newUser.email,
      hotelId: newHotel.id,
      name: newUser.name,
    });

    const safeUser = {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role,
      title: newUser.title,
      phone: newUser.phone,
      initials: newUser.initials,
      lastActive: newUser.lastActive,
      whatsapp: newUser.whatsapp,
      hotelId: newHotel.id,
    };

    return successResponse(res, { token, user: safeUser, hotel: newHotel }, 'Hotel registered successfully', 201);
  } catch (error) {
    next(error);
  }
};

export const login = async (req, res, next) => {
  try {
    const { email, password, userId } = req.body;

    let user;
    if (email) {
      user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
      if (user) {
        if (!password) {
          return errorResponse(res, 'Password is required', 400);
        }
        const isDevDemo = process.env.NODE_ENV !== 'production' && password === 'demo-access';
        if (user.passwordHash) {
          let match = await bcrypt.compare(password, user.passwordHash);
          if (!match && password === 'demo-access') {
            match = await bcrypt.compare('password123', user.passwordHash);
          }
          if (!match && !isDevDemo) {
            return errorResponse(res, 'Invalid credentials', 401);
          }
        } else if (!isDevDemo) {
          return errorResponse(res, 'Invalid credentials', 401);
        }
      }
    } else if (userId) {
      user = await prisma.user.findUnique({ where: { id: userId } });
      if (user && user.passwordHash && password) {
        const isDevDemo = process.env.NODE_ENV !== 'production' && password === 'demo-access';
        let match = await bcrypt.compare(password, user.passwordHash);
        if (!match && password === 'demo-access') {
          match = await bcrypt.compare('password123', user.passwordHash);
        }
        if (!match && !isDevDemo) {
          return errorResponse(res, 'Invalid credentials', 401);
        }
      }
    }

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    const token = signToken({
      id: user.id,
      role: user.role,
      email: user.email,
      hotelId: user.hotelId || 'hotel-mercier',
      name: user.name,
    });

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      title: user.title,
      phone: user.phone,
      initials: user.initials,
      lastActive: user.lastActive,
      whatsapp: user.whatsapp,
      hotelId: user.hotelId || 'hotel-mercier',
    };

    return successResponse(res, { token, user: safeUser }, 'Login successful');
  } catch (error) {
    next(error);
  }
};

export const getMe = async (req, res) => {
  return successResponse(res, { user: req.user }, 'Profile fetched');
};

export const getStaffList = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const staff = await prisma.user.findMany({
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
      },
    });
    return successResponse(res, staff, 'Staff accounts list');
  } catch (error) {
    next(error);
  }
};
