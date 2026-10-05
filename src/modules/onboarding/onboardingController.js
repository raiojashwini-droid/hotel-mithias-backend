import bcrypt from 'bcryptjs';
import { prisma } from '../../config/database.js';
import { errorResponse, successResponse } from '../../utils/response.js';
import { sendBrevoInvitationEmail } from '../../utils/mailer.js';

let columnsChecked = false;
let waColumnsChecked = false;

async function ensureHotelColumns() {
  if (columnsChecked) return;
  try {
    const columns = await prisma.$queryRawUnsafe('SHOW COLUMNS FROM Hotel');
    const colNames = Array.isArray(columns) ? columns.map((c) => c.Field) : [];

    if (!colNames.includes('waTopology')) {
      await prisma.$executeRawUnsafe("ALTER TABLE Hotel ADD COLUMN waTopology VARCHAR(191) DEFAULT 'separate'").catch(() => {});
    }
    if (!colNames.includes('onboardingDone')) {
      await prisma.$executeRawUnsafe("ALTER TABLE Hotel ADD COLUMN onboardingDone TINYINT(1) DEFAULT 0").catch(() => {});
    }
    if (!colNames.includes('onboardingSteps')) {
      await prisma.$executeRawUnsafe("ALTER TABLE Hotel ADD COLUMN onboardingSteps TEXT").catch(() => {});
    }
    columnsChecked = true;
  } catch (err) {
    // Graceful fallback if SHOW COLUMNS fails
  }
}

export async function ensureWhatsAppColumns() {
  if (waColumnsChecked) return;
  try {
    const columns = await prisma.$queryRawUnsafe('SHOW COLUMNS FROM WhatsAppIntegration').catch(() => []);
    const colNames = Array.isArray(columns) ? columns.map((c) => c.Field) : [];

    if (colNames.length > 0) {
      if (!colNames.includes('displayPhoneNumber')) {
        await prisma.$executeRawUnsafe("ALTER TABLE WhatsAppIntegration ADD COLUMN displayPhoneNumber VARCHAR(191) NULL").catch(() => {});
      }
      if (!colNames.includes('phoneNumberId')) {
        await prisma.$executeRawUnsafe("ALTER TABLE WhatsAppIntegration ADD COLUMN phoneNumberId VARCHAR(191) NULL").catch(() => {});
      }
      if (!colNames.includes('accessToken')) {
        await prisma.$executeRawUnsafe("ALTER TABLE WhatsAppIntegration ADD COLUMN accessToken TEXT NULL").catch(() => {});
      }
    }
    waColumnsChecked = true;
  } catch (err) {
    // Graceful fallback
  }
}

export const getOnboardingStatus = async (req, res, next) => {
  try {
    await ensureHotelColumns();
    const hotelId = req.user?.hotelId || 'hotel-mercier';

    let hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel && !req.user?.hotelId && hotelId === 'hotel-mercier') {
      hotel = await prisma.hotel.findFirst();
    }

    let stepsDone = ['profile'];
    if (hotel?.onboardingSteps) {
      try {
        stepsDone = JSON.parse(hotel.onboardingSteps);
      } catch {
        stepsDone = ['profile'];
      }
    }

    const targetHotelId = hotel?.id || hotelId;

    // Check real active integrations from database
    const [pmsInteg, emailInteg, waIntegs] = await Promise.all([
      prisma.pmsIntegration.findUnique({ where: { hotelId: targetHotelId } }).catch(() => null),
      prisma.emailIntegration.findUnique({ where: { hotelId: targetHotelId } }).catch(() => null),
      prisma.whatsAppIntegration.findMany({ where: { hotelId: targetHotelId, status: 'connected' } }).catch(() => []),
    ]);

    const isPmsConnected = pmsInteg?.status === 'connected';
    const isEmailConnected = emailInteg?.status === 'connected';
    const hasWaGuest = waIntegs.some((w) => w.targetType === 'guest' || w.targetType === 'both');
    const hasWaInternal = waIntegs.some((w) => w.targetType === 'internal' || w.targetType === 'both');

    if (isPmsConnected && !stepsDone.includes('pms')) stepsDone.push('pms');
    if (isEmailConnected && !stepsDone.includes('email')) stepsDone.push('email');
    if (hasWaGuest && !stepsDone.includes('wa-guest')) stepsDone.push('wa-guest');
    if (hasWaInternal && !stepsDone.includes('wa-internal')) stepsDone.push('wa-internal');

    const doneMap = {
      profile: stepsDone.includes('profile'),
      pms: isPmsConnected || stepsDone.includes('pms'),
      email: isEmailConnected || stepsDone.includes('email'),
      'wa-guest': hasWaGuest || stepsDone.includes('wa-guest'),
      'wa-internal': hasWaInternal || stepsDone.includes('wa-internal'),
      knowledge: stepsDone.includes('knowledge'),
      users: stepsDone.includes('users'),
      ai: stepsDone.includes('ai'),
    };

    // Synchronize OnboardingState table
    prisma.onboardingState.upsert({
      where: { hotelId: targetHotelId },
      update: {
        pmsDone: doneMap.pms,
        emailDone: doneMap.email,
        guestWaDone: doneMap['wa-guest'],
        internalWaDone: doneMap['wa-internal'],
        kbDone: doneMap.knowledge,
        usersDone: doneMap.users,
        aiDone: doneMap.ai,
      },
      create: {
        hotelId: targetHotelId,
        pmsDone: doneMap.pms,
        emailDone: doneMap.email,
        guestWaDone: doneMap['wa-guest'],
        internalWaDone: doneMap['wa-internal'],
        kbDone: doneMap.knowledge,
        usersDone: doneMap.users,
        aiDone: doneMap.ai,
      },
    }).catch(() => {});

    const profile = {
      name: hotel?.name || 'My Hotel',
      legalName: hotel?.legalName || `${hotel?.name || 'My Hotel'} BV`,
      stars: Number(hotel?.stars) || 4,
      rooms: Number(hotel?.roomsCount) || 0,
      address: hotel?.address || '',
      postcode: hotel?.postcode || '',
      city: hotel?.city || '',
      country: hotel?.country || '',
      phone: hotel?.phone || '',
      email: hotel?.email || '',
      website: hotel?.website || '',
      bookingEngine: hotel?.bookingEngine || '',
      whatsappNumber: hotel?.whatsappNumber || '',
      checkIn: hotel?.checkIn || '15:00',
      checkOut: hotel?.checkOut || '11:00',
      languages: ['Dutch', 'French', 'English', 'German'],
      description: hotel?.description || '',
    };

    return successResponse(res, {
      hotelId,
      waTopology: hotel?.waTopology || 'separate',
      complete: Boolean(hotel?.onboardingDone),
      done: doneMap,
      hotelProfile: profile,
    }, 'Onboarding status fetched');
  } catch (error) {
    next(error);
  }
};

export const getHotelProfile = async (req, res, next) => {
  try {
    await ensureHotelColumns();
    const hotelId = req.user?.hotelId || 'hotel-mercier';

    let hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel && hotelId === 'hotel-mercier') {
      hotel = await prisma.hotel.findFirst();
    }

    const profile = {
      name: hotel?.name || 'My Hotel',
      legalName: hotel?.legalName || `${hotel?.name || 'My Hotel'} BV`,
      stars: Number(hotel?.stars) || 4,
      rooms: Number(hotel?.roomsCount) || 0,
      address: hotel?.address || '',
      postcode: hotel?.postcode || '',
      city: hotel?.city || '',
      country: hotel?.country || '',
      phone: hotel?.phone || '',
      email: hotel?.email || '',
      website: hotel?.website || '',
      bookingEngine: hotel?.bookingEngine || '',
      whatsappNumber: hotel?.whatsappNumber || '',
      checkIn: hotel?.checkIn || '15:00',
      checkOut: hotel?.checkOut || '11:00',
      languages: ['Dutch', 'French', 'English', 'German'],
      description: hotel?.description || '',
    };

    return successResponse(res, profile, 'Hotel profile fetched');
  } catch (error) {
    next(error);
  }
};

export const saveHotelProfile = async (req, res, next) => {
  try {
    await ensureHotelColumns();
    const hotelId = req.user?.hotelId || 'hotel-mercier';

    const data = req.body;
    if (!data) {
      return errorResponse(res, 'Profile data required', 400);
    }

    let hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel && !req.user?.hotelId && hotelId === 'hotel-mercier') {
      hotel = await prisma.hotel.findFirst();
    }

    const targetHotelId = hotel?.id || hotelId;

    let stepsDone = ['profile'];
    if (hotel?.onboardingSteps) {
      try {
        stepsDone = JSON.parse(hotel.onboardingSteps);
      } catch {
        stepsDone = ['profile'];
      }
    }
    if (!stepsDone.includes('profile')) {
      stepsDone.push('profile');
    }

    if (hotel) {
      await prisma.hotel.update({
        where: { id: targetHotelId },
        data: {
          name: data.name ?? hotel.name,
          legalName: data.legalName ?? hotel.legalName,
          stars: Number(data.stars) || hotel.stars || 4,
          roomsCount: Number(data.rooms || data.roomsCount) || hotel.roomsCount || 0,
          address: data.address ?? hotel.address,
          postcode: data.postcode ?? hotel.postcode,
          city: data.city ?? hotel.city,
          country: data.country ?? hotel.country,
          phone: data.phone ?? hotel.phone,
          email: data.email ?? hotel.email,
          website: data.website ?? hotel.website,
          checkIn: data.checkIn ?? hotel.checkIn ?? '15:00',
          checkOut: data.checkOut ?? hotel.checkOut ?? '11:00',
          description: data.description ?? hotel.description ?? '',
          onboardingSteps: JSON.stringify(stepsDone),
        },
      });
    } else {
      await prisma.hotel.create({
        data: {
          id: targetHotelId,
          name: data.name || 'My Hotel',
          legalName: data.legalName || `${data.name || 'My Hotel'} BV`,
          stars: Number(data.stars) || 4,
          roomsCount: Number(data.rooms || data.roomsCount) || 0,
          address: data.address || '',
          postcode: data.postcode || '',
          city: data.city || '',
          country: data.country || '',
          phone: data.phone || '',
          email: data.email || '',
          website: data.website || '',
          bookingEngine: data.bookingEngine || '',
          whatsappNumber: data.whatsappNumber || '',
          checkIn: data.checkIn || '15:00',
          checkOut: data.checkOut || '11:00',
          vatNumber: data.vatNumber || '',
          description: data.description || '',
          onboardingSteps: JSON.stringify(stepsDone),
        },
      });
    }

    return successResponse(res, {
      profile: data,
      onboardingSteps: stepsDone,
      done: true,
    }, 'Hotel profile saved successfully');
  } catch (error) {
    next(error);
  }
};

export const saveTopology = async (req, res, next) => {
  try {
    await ensureHotelColumns();
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { topology } = req.body;

    if (!topology) {
      return errorResponse(res, 'Topology choice is required', 400);
    }

    await prisma.hotel.update({
      where: { id: hotelId },
      data: { waTopology: topology },
    }).catch(() => {});

    return successResponse(res, { waTopology: topology }, 'WhatsApp topology saved');
  } catch (error) {
    next(error);
  }
};

export const saveOnboardingStep = async (req, res, next) => {
  try {
    await ensureHotelColumns();
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { stepKey, data } = req.body;

    if (!stepKey) {
      return errorResponse(res, 'Step key is required', 400);
    }

    let hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel && hotelId === 'hotel-mercier') {
      hotel = await prisma.hotel.findFirst();
    }

    let stepsDone = ['profile'];
    if (hotel?.onboardingSteps) {
      try {
        stepsDone = JSON.parse(hotel.onboardingSteps);
      } catch {
        stepsDone = ['profile'];
      }
    }
    if (!stepsDone.includes(stepKey)) {
      stepsDone.push(stepKey);
    }

    // Keep OnboardingState table in sync with step progression
    const stepFieldMap = {
      pms: 'pmsDone',
      email: 'emailDone',
      'wa-guest': 'guestWaDone',
      'wa-internal': 'internalWaDone',
      knowledge: 'kbDone',
      users: 'usersDone',
      ai: 'aiDone',
    };
    const stateField = stepFieldMap[stepKey];
    if (stateField) {
      prisma.onboardingState.upsert({
        where: { hotelId: hotel?.id || hotelId },
        update: { [stateField]: true },
        create: { hotelId: hotel?.id || hotelId, [stateField]: true },
      }).catch(() => {});
    }

    const updateData = {
      onboardingSteps: JSON.stringify(stepsDone),
    };

    if (stepKey === 'email' && data?.address) {
      updateData.email = data.address;
    }

    if (stepKey === 'wa-guest' && (data?.phone || data?.displayPhoneNumber)) {
      updateData.whatsappNumber = data.phone || data.displayPhoneNumber;
    }

    if (hotel) {
      await prisma.hotel.update({
        where: { id: hotel.id },
        data: updateData,
      }).catch(() => {});
    }

    // Ensure WhatsAppIntegration table columns are ready
    if (stepKey === 'wa-guest' || stepKey === 'wa-internal') {
      await ensureWhatsAppColumns();
      const targetType = stepKey === 'wa-guest' ? 'guest' : 'internal';
      const rawPhone = data?.phone || data?.displayPhoneNumber || (targetType === 'guest' ? hotel?.whatsappNumber : hotel?.phone) || '';
      const cleanPhone = String(rawPhone).replace(/\D/g, '');
      const phoneNumberId = data?.phoneNumberId || `phone_${cleanPhone || Date.now()}`;
      const wabaId = data?.wabaId || `waba_${hotelId}_${targetType}`;
      const accessToken = data?.accessToken || null;

      if (cleanPhone || phoneNumberId) {
        try {
          await prisma.whatsAppIntegration.upsert({
            where: {
              hotelId_targetType: {
                hotelId,
                targetType,
              },
            },
            update: {
              phoneNumber: cleanPhone,
              displayPhoneNumber: rawPhone,
              phoneNumberId,
              wabaId,
              ...(accessToken ? { accessToken } : {}),
              status: 'connected',
              lastError: null,
            },
            create: {
              hotelId,
              targetType,
              phoneNumber: cleanPhone,
              displayPhoneNumber: rawPhone,
              phoneNumberId,
              wabaId,
              accessToken,
              status: 'connected',
            },
          });
        } catch (waErr) {
          console.warn('[Onboarding WhatsAppIntegration Upsert Warning]:', waErr.message);
        }
      }
    }

    // Log activity if an email mailbox is connected
    if (stepKey === 'email') {
      try {
        await prisma.activityItem.create({
          data: {
            id: `act-${Date.now()}`,
            hotelId,
            at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
            kind: 'room',
            text: `Guest mailbox connected: ${data?.address || hotel?.email || 'reception'}`,
            meta: 'Setup Wizard',
          },
        });
      } catch {}
    }

    // Log activity if guest WhatsApp is connected
    if (stepKey === 'wa-guest') {
      try {
        await prisma.activityItem.create({
          data: {
            id: `act-${Date.now()}`,
            hotelId,
            at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
            kind: 'room',
            text: `Guest WhatsApp connected: ${data?.phone || hotel?.whatsappNumber || ''}`,
            meta: 'Setup Wizard',
          },
        });
      } catch {}
    }

    // Log activity if internal staff WhatsApp is connected
    if (stepKey === 'wa-internal') {
      try {
        await prisma.activityItem.create({
          data: {
            id: `act-${Date.now()}`,
            hotelId,
            at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
            kind: 'room',
            text: `Internal Staff WhatsApp connected: ${data?.phone || hotel?.phone || ''}`,
            meta: 'Setup Wizard',
          },
        });
      } catch {}
    }

    // Handle Step 7: Invite Users (User Upsert + Brevo Transactional Email Dispatch)
    // Handle Step 7: Invite Users (User Upsert + Brevo Transactional Email Dispatch)
    if (stepKey === 'users') {
      try {
        const inviteEmail = data?.email || data?.address;
        const inviteRole = data?.role || 'front-office';

        if (inviteEmail) {
          const rawName = inviteEmail.split('@')[0].replace(/[._-]/g, ' ');
          const formattedName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
          const initials = formattedName.split(' ').map(w => w[0]?.toUpperCase() || '').join('').slice(0, 2) || 'ST';

          const roleTitleMap = {
            'manager': 'General Manager',
            'front-office': 'Front Desk Agent',
            'housekeeping': 'Housekeeping Staff',
            'maintenance': 'Maintenance Technician',
          };

          const userTitle = roleTitleMap[inviteRole] || 'Staff Member';
          const isWhatsappRole = inviteRole === 'housekeeping' || inviteRole === 'maintenance';

          // Multi-tenant isolation check: do not overwrite user belonging to another hotel
          const existingUser = await prisma.user.findUnique({
            where: { email: inviteEmail.toLowerCase() },
          });
          if (existingUser && existingUser.hotelId !== hotelId) {
            return errorResponse(res, `User with email ${inviteEmail} is already registered with another property`, 409);
          }

          // Generate a unique temporary password instead of a shared static string
          const tempPassword = `Hx-${Math.random().toString(36).slice(2, 8).toUpperCase()}!${Math.floor(100 + Math.random() * 900)}`;
          const defaultHash = bcrypt.hashSync(tempPassword, 10);

          // 1. Physically Upsert User Record into MySQL Database scoped to hotelId
          await prisma.user.upsert({
            where: { email: inviteEmail.toLowerCase() },
            update: {
              hotelId,
              role: inviteRole,
              title: userTitle,
              whatsapp: isWhatsappRole,
            },
            create: {
              hotelId,
              name: formattedName,
              email: inviteEmail.toLowerCase(),
              role: inviteRole,
              title: userTitle,
              phone: '',
              initials,
              whatsapp: isWhatsappRole,
              passwordHash: defaultHash,
            },
          });

          // 2. Dispatch Invitation Email with generated temporary password
          await sendBrevoInvitationEmail({
            toEmail: inviteEmail.toLowerCase(),
            toName: formattedName,
            role: inviteRole,
            title: userTitle,
            hotelName: hotel?.name || 'Hotelogx Connect',
            loginUrl: 'http://localhost:5173/login',
            temporaryPassword: tempPassword,
          });

          // 3. Log Activity Feed Entry in MySQL
          await prisma.activityItem.create({
            data: {
              id: `act-${Date.now()}`,
              hotelId,
              at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
              kind: 'task',
              text: `Invited team member: ${inviteEmail} (${userTitle})`,
              meta: 'Setup Wizard',
            },
          });
        }
      } catch (userErr) {
        console.warn('[Onboarding Users Warning]', userErr.message);
      }
    }

    // Handle Step 8: AI Rules & Mode Persistence
    if (stepKey === 'ai' && data) {
      try {
        if (data.aiMode) {
          await prisma.hotel.update({
            where: { id: hotel?.id || hotelId },
            data: { aiMode: data.aiMode },
          }).catch(() => {});
        }
        if (Array.isArray(data.rules)) {
          for (const r of data.rules) {
            if (!r.topic || !r.mode) continue;
            await prisma.aiRule.upsert({
              where: {
                hotelId_topic: {
                  hotelId: hotel?.id || hotelId,
                  topic: r.topic,
                },
              },
              update: {
                mode: r.mode,
                note: r.note || '',
              },
              create: {
                hotelId: hotel?.id || hotelId,
                topic: r.topic,
                mode: r.mode,
                note: r.note || '',
              },
            }).catch(() => {});
          }
        }
      } catch (aiErr) {
        console.warn('[Onboarding AI Step Warning]:', aiErr.message);
      }
    }

    return successResponse(res, {
      stepKey,
      onboardingSteps: stepsDone,
      email: data?.email || data?.address,
      phone: data?.phone,
      role: data?.role,
    }, `Step ${stepKey} saved successfully`);
  } catch (error) {
    next(error);
  }
};

export const completeOnboarding = async (req, res, next) => {
  try {
    await ensureHotelColumns();
    const hotelId = req.user?.hotelId || 'hotel-mercier';

    let hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel && hotelId === 'hotel-mercier') {
      hotel = await prisma.hotel.findFirst();
    }

    if (hotel) {
      await prisma.hotel.update({
        where: { id: hotel.id },
        data: { onboardingDone: true },
      });

      await prisma.onboardingState.upsert({
        where: { hotelId: hotel.id },
        update: {
          pmsDone: true,
          emailDone: true,
          guestWaDone: true,
          internalWaDone: true,
          kbDone: true,
          usersDone: true,
          aiDone: true,
          currentStep: 8,
        },
        create: {
          hotelId: hotel.id,
          pmsDone: true,
          emailDone: true,
          guestWaDone: true,
          internalWaDone: true,
          kbDone: true,
          usersDone: true,
          aiDone: true,
          currentStep: 8,
        },
      }).catch(() => {});
    }

    try {
      await prisma.activityItem.create({
        data: {
          id: `act-${Date.now()}`,
          hotelId,
          at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
          kind: 'room',
          text: `${hotel?.name || 'Hotel'} onboarding completed and live!`,
          meta: 'Setup Wizard',
        },
      });
    } catch {}

    return successResponse(res, { complete: true }, 'Onboarding completed');
  } catch (error) {
    next(error);
  }
};

export const handleEmailDetect = async (req, res, next) => {
  try {
    const input = req.query.email || req.query.domain || '';
    const { detectEmailProvider } = await import('../../utils/emailDetect.js');
    const result = await detectEmailProvider(input);
    return res.json(result);
  } catch (error) {
    next(error);
  }
};

