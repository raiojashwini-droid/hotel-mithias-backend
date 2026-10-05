import { prisma } from '../../config/database.js';
import { successResponse, errorResponse } from '../../utils/response.js';

const VALID_PLANS = ['starter', 'pro', 'enterprise'];
const VALID_CYCLES = ['monthly', 'yearly'];

const PLAN_PRICE_MAP = {
  starter: 5.0,
  pro: 7.0,
  enterprise: 9.5,
};

export const getSubscription = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';

    let subscription = await prisma.subscription.findUnique({
      where: { hotelId },
      include: {
        invoices: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!subscription) {
      // Deterministically create default subscription for this hotel
      let hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
      if (!hotel) {
        hotel = await prisma.hotel.upsert({
          where: { id: hotelId },
          update: {},
          create: {
            id: hotelId,
            name: 'Hotel Mercier',
            legalName: 'Hotel Mercier BV',
            stars: 4,
            roomsCount: 48,
            address: 'Leopoldstraat 42',
            postcode: '2000',
            city: 'Antwerp',
            country: 'Belgium',
            timezone: 'Europe/Brussels',
            currency: '€',
            phone: '+32 3 227 41 00',
            email: 'reception@hotelmercier.be',
            website: 'hotelmercier.be',
            bookingEngine: 'hotelmercier.be/book',
            whatsappNumber: '+32 3 227 41 08',
            checkIn: '15:00',
            checkOut: '11:00',
            vatNumber: 'BE 0784.512.339',
            description: 'Hotel Mercier 4-star townhouse property',
          },
        });
      }
      const rooms = hotel?.roomsCount || 48;
      const hotelName = hotel?.name || 'Hotel Mercier BV';

      subscription = await prisma.subscription.create({
        data: {
          hotelId,
          plan: 'pro',
          status: 'Active',
          billingCycle: 'monthly',
          rooms,
          pricePerRoom: 7.0,
          seatsUsed: 4,
          startedOn: '14 Aug 2025',
          renewsOn: '14 Sep 2026',
          paymentBrand: 'Visa',
          paymentLast4: '4417',
          paymentExpiry: '09/28',
          paymentHolder: hotel?.legalName || hotelName,
          provider: 'none',
          invoices: {
            create: [
              {
                hotelId,
                number: 'INV-2026-08',
                period: '14 Aug — 13 Sep 2026',
                date: '14 Aug 2026',
                amount: rooms * 7.0,
                currency: 'EUR',
                status: 'Paid',
              },
              {
                hotelId,
                number: 'INV-2026-07',
                period: '14 Jul — 13 Aug 2026',
                date: '14 Jul 2026',
                amount: rooms * 7.0,
                currency: 'EUR',
                status: 'Paid',
              },
              {
                hotelId,
                number: 'INV-2026-06',
                period: '14 Jun — 13 Jul 2026',
                date: '14 Jun 2026',
                amount: rooms * 7.0,
                currency: 'EUR',
                status: 'Paid',
              },
            ],
          },
        },
        include: {
          invoices: {
            orderBy: { createdAt: 'desc' },
          },
        },
      });
    }

    // Format for frontend
    const formatted = {
      plan: subscription.plan,
      status: subscription.status,
      billingCycle: subscription.billingCycle,
      rooms: subscription.rooms,
      pricePerRoom: subscription.pricePerRoom,
      seatsUsed: subscription.seatsUsed,
      startedOn: subscription.startedOn,
      renewsOn: subscription.renewsOn,
      paymentMethod: {
        brand: subscription.paymentBrand || 'Visa',
        last4: subscription.paymentLast4 || '4417',
        expiry: subscription.paymentExpiry || '09/28',
        holder: subscription.paymentHolder || 'Hotel Account',
      },
      usage: {
        conversations: 1240,
        aiReplies: 1104,
        whatsappMessages: 2840,
        upsellRevenue: 3420,
      },
      invoices: subscription.invoices,
    };

    return successResponse(res, formatted, 'Subscription retrieved successfully');
  } catch (error) {
    next(error);
  }
};

export const updateSubscription = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Unauthorized - Missing hotel identification', 401);
    }

    const { plan, billingCycle, rooms } = req.body;

    const dataToUpdate = {};

    if (plan !== undefined) {
      if (!VALID_PLANS.includes(plan)) {
        return errorResponse(res, `Invalid plan. Allowed plans: ${VALID_PLANS.join(', ')}`, 400);
      }
      dataToUpdate.plan = plan;
      dataToUpdate.pricePerRoom = PLAN_PRICE_MAP[plan] || 7.0;
    }

    if (billingCycle !== undefined) {
      if (!VALID_CYCLES.includes(billingCycle)) {
        return errorResponse(res, `Invalid billingCycle. Allowed cycles: ${VALID_CYCLES.join(', ')}`, 400);
      }
      dataToUpdate.billingCycle = billingCycle;
    }

    if (rooms !== undefined && Number(rooms) > 0) {
      dataToUpdate.rooms = Number(rooms);
    }

    const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
    const hotelRooms = hotel?.roomsCount || 48;

    const updated = await prisma.subscription.upsert({
      where: { hotelId },
      update: dataToUpdate,
      create: {
        hotelId,
        plan: plan || 'pro',
        billingCycle: billingCycle || 'monthly',
        pricePerRoom: PLAN_PRICE_MAP[plan || 'pro'] || 7.0,
        rooms: Number(rooms) || hotelRooms,
        status: 'Active',
        seatsUsed: 4,
        startedOn: '14 Aug 2025',
        renewsOn: '14 Sep 2026',
        paymentBrand: 'Visa',
        paymentLast4: '4417',
        paymentExpiry: '09/28',
        paymentHolder: hotel?.legalName || hotel?.name || 'Hotel Account',
      },
      include: {
        invoices: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    const formatted = {
      plan: updated.plan,
      status: updated.status,
      billingCycle: updated.billingCycle,
      rooms: updated.rooms,
      pricePerRoom: updated.pricePerRoom,
      seatsUsed: updated.seatsUsed,
      startedOn: updated.startedOn,
      renewsOn: updated.renewsOn,
      paymentMethod: {
        brand: updated.paymentBrand || 'Visa',
        last4: updated.paymentLast4 || '4417',
        expiry: updated.paymentExpiry || '09/28',
        holder: updated.paymentHolder || 'Hotel Account',
      },
      usage: {
        conversations: 1240,
        aiReplies: 1104,
        whatsappMessages: 2840,
        upsellRevenue: 3420,
      },
      invoices: updated.invoices,
    };

    return successResponse(res, formatted, 'Subscription updated successfully');
  } catch (error) {
    next(error);
  }
};

export const getInvoices = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';

    const invoices = await prisma.invoice.findMany({
      where: { hotelId },
      orderBy: { createdAt: 'desc' },
    });

    return successResponse(res, invoices, 'Invoices retrieved successfully');
  } catch (error) {
    next(error);
  }
};
