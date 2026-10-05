import { prisma } from '../../config/database.js';

export const onboardingService = {
  /**
   * Get onboarding status for a hotel based on MySQL Hotel and PmsIntegration records
   */
  async getStatus(hotelId) {
    let targetHotelId = hotelId;
    let hotel = await prisma.hotel.findUnique({ where: { id: hotelId } }).catch(() => null);
    if (!hotel) {
      hotel = await prisma.hotel.findFirst().catch(() => null);
      if (hotel) targetHotelId = hotel.id;
    }

    let stepsDone = ['profile'];
    if (hotel?.onboardingSteps) {
      try {
        stepsDone = JSON.parse(hotel.onboardingSteps);
      } catch {
        stepsDone = ['profile'];
      }
    }

    // Check real PMS integration status in database
    const pmsIntegration = await prisma.pmsIntegration.findUnique({
      where: { hotelId: targetHotelId },
    }).catch(() => null);

    const isPmsConnected = pmsIntegration?.status === 'connected';
    if (isPmsConnected && !stepsDone.includes('pms')) {
      stepsDone.push('pms');
    }

    return {
      hotelId: targetHotelId,
      complete: Boolean(hotel?.onboardingDone),
      onboardingSteps: stepsDone,
      pmsConnected: isPmsConnected,
      pmsProvider: pmsIntegration?.provider || null,
      pmsPropertyId: pmsIntegration?.propertyId || null,
      lastSyncAt: pmsIntegration?.lastSyncAt || null,
      done: {
        profile: stepsDone.includes('profile'),
        pms: isPmsConnected || stepsDone.includes('pms'),
        email: stepsDone.includes('email'),
        'wa-guest': stepsDone.includes('wa-guest'),
        'wa-internal': stepsDone.includes('wa-internal'),
        knowledge: stepsDone.includes('knowledge'),
        users: stepsDone.includes('users'),
        ai: stepsDone.includes('ai'),
      },
    };
  },

  /**
   * Update onboarding status and completed steps
   */
  async updateStatus(hotelId, data) {
    let targetHotelId = hotelId;
    let hotel = await prisma.hotel.findUnique({ where: { id: hotelId } }).catch(() => null);
    if (!hotel) {
      hotel = await prisma.hotel.findFirst().catch(() => null);
      if (hotel) targetHotelId = hotel.id;
    }

    if (!hotel) return null;

    let steps = [];
    try {
      steps = JSON.parse(hotel.onboardingSteps || '[]');
    } catch {
      steps = [];
    }

    if (data?.step && !steps.includes(data.step)) {
      steps.push(data.step);
    }

    const updatePayload = {
      onboardingSteps: JSON.stringify(steps),
      ...(data?.complete !== undefined ? { onboardingDone: Boolean(data.complete) } : {}),
      ...(data?.waTopology ? { waTopology: data.waTopology } : {}),
    };

    const updated = await prisma.hotel.update({
      where: { id: targetHotelId },
      data: updatePayload,
    });

    return updated;
  },
};
