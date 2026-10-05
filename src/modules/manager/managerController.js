import { prisma } from '../../config/database.js';
import { errorResponse, successResponse } from '../../utils/response.js';

export const DEFAULT_AI_RULES = [
  { topic: 'General questions', mode: 'Autonomous', note: 'Wi-Fi, directions, opening hours' },
  { topic: 'Hotel information', mode: 'Autonomous', note: 'Answered from the knowledge base' },
  { topic: 'Availability & pricing', mode: 'Autonomous', note: 'Reads Mews, never books' },
  { topic: 'Upsells', mode: 'Autonomous', note: 'Only offers from the priced catalogue' },
  { topic: 'Housekeeping requests', mode: 'Autonomous', note: 'Creates tasks and confirms to the guest' },
  { topic: 'Maintenance reports', mode: 'Autonomous', note: 'Opens a ticket, notifies the technician' },
  { topic: 'Late checkout / early check-in', mode: 'Human Approval', note: 'Depends on occupancy' },
  { topic: 'Complaints', mode: 'Human Approval', note: 'AI drafts, a human sends' },
  { topic: 'Refunds', mode: 'Always Escalate', note: 'Never handled by AI' },
  { topic: 'Billing disputes', mode: 'Always Escalate', note: 'Folio pulled and attached' },
  { topic: 'Safety issues', mode: 'Always Escalate', note: 'Duty manager notified immediately' },
  { topic: 'VIP guests', mode: 'Human Approval', note: 'AI prepares, staff confirms' },
];

const VALID_GLOBAL_MODES = ['Autonomous', 'Approval Required', 'Suggestions Only'];
const MODE_MAP = {
  Auto: 'Autonomous',
  Autonomous: 'Autonomous',
  Approve: 'Human Approval',
  'Human Approval': 'Human Approval',
  Escalate: 'Always Escalate',
  'Always Escalate': 'Always Escalate',
};

export const getBriefing = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) return errorResponse(res, 'Unauthorized', 401);

    const [
      hotel,
      rooms,
      openTasks,
      openIssues,
      conversations,
      upsells,
      activities,
    ] = await Promise.all([
      prisma.hotel.findUnique({ where: { id: hotelId } }).catch(() => null),
      prisma.room.findMany({ where: { hotelId } }),
      prisma.task.count({ where: { hotelId, status: { not: 'Completed' } } }),
      prisma.issue.count({ where: { hotelId, status: { not: 'Completed' } } }),
      prisma.conversation.findMany({
        where: { guest: { hotelId } },
        include: { guest: true },
      }),
      prisma.upsell.findMany({ where: { hotelId } }).catch(() => []),
      prisma.activityItem.findMany({ where: { hotelId }, take: 10, orderBy: { id: 'desc' } }),
    ]);

    const totalRooms = rooms.length || 0;
    const occupiedRooms = rooms.filter((r) => r.guestStatus !== 'Vacant').length;
    const cleanRooms = rooms.filter((r) => r.status === 'Clean' || r.status === 'Inspected').length;
    const dirtyRooms = rooms.filter((r) => r.status === 'Dirty').length;
    const vipArrivals = rooms.filter((r) => r.vip && r.arrivalTime).length;

    const escalations = conversations
      .filter((c) => c.escalation)
      .map((c) => {
        let parsedEscalation = null;
        try {
          parsedEscalation = typeof c.escalation === 'string' ? JSON.parse(c.escalation) : c.escalation;
        } catch (_) {
          parsedEscalation = { reason: String(c.escalation) };
        }
        return {
          id: c.id,
          guestName: c.guest?.name || c.guestId,
          room: c.guest?.room || undefined,
          escalation: parsedEscalation,
        };
      });

    const acceptedUpsellsTotal = upsells
      .filter((u) => u.status === 'Accepted')
      .reduce((acc, curr) => acc + curr.value, 0);

    const occupancyPct = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0;

    // Synthesize Dynamic Operational AI Advice
    const aiAdvice = [];
    if (dirtyRooms > cleanRooms) {
      aiAdvice.push({
        topic: 'Housekeeping Pace',
        level: 'attend',
        title: `${dirtyRooms} dirty rooms vs ${cleanRooms} ready`,
        action: 'Prioritize departure cleaning before standard 15:00 check-in window.',
      });
    } else {
      aiAdvice.push({
        topic: 'Housekeeping Pace',
        level: 'good',
        title: 'Housekeeping turnaround on schedule',
        action: `${cleanRooms} rooms inspected and released for arrivals.`,
      });
    }

    if (vipArrivals > 0) {
      aiAdvice.push({
        topic: 'VIP Arrivals',
        level: 'urgent',
        title: `${vipArrivals} VIP arrival${vipArrivals > 1 ? 's' : ''} scheduled today`,
        action: 'Verify welcome praline amenities and room key cards at reception prior to arrival.',
      });
    }

    if (occupancyPct >= 80) {
      aiAdvice.push({
        topic: 'Revenue & Upsell',
        level: 'good',
        title: `High occupancy day (${occupancyPct}%)`,
        action: 'Restrict unpaid late check-outs and offer premium room upgrades to arriving guests.',
      });
    } else {
      aiAdvice.push({
        topic: 'Direct Bookings',
        level: 'ai',
        title: `Current occupancy at ${occupancyPct}%`,
        action: 'Encourage direct website booking links for all incoming inquiries on WhatsApp.',
      });
    }

    if (openIssues > 0) {
      aiAdvice.push({
        topic: 'Maintenance',
        level: 'attend',
        title: `${openIssues} active maintenance ticket${openIssues > 1 ? 's' : ''}`,
        action: 'Follow up with engineering via WhatsApp simulator to clear rooms back to service.',
      });
    }

    const briefing = {
      hotelName: hotel?.name || 'Hotel',
      occupancy: {
        total: totalRooms,
        occupied: occupiedRooms,
        rate: occupancyPct,
        clean: cleanRooms,
        dirty: dirtyRooms,
        vipArrivals,
      },
      operations: {
        openTasks,
        openIssues,
        pendingEscalations: escalations.length,
      },
      upsellRevenue: acceptedUpsellsTotal,
      escalations,
      aiAdvice,
      recentActivity: activities,
    };

    return successResponse(res, briefing, 'Manager briefing aggregated');
  } catch (error) {
    next(error);
  }
};

export const getActivityFeed = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) return errorResponse(res, 'Unauthorized', 401);
    const activities = await prisma.activityItem.findMany({
      where: { hotelId },
      take: 20,
      orderBy: { id: 'desc' },
    });
    return successResponse(res, activities, 'Activity feed');
  } catch (error) {
    next(error);
  }
};

export const getAiRules = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) return errorResponse(res, 'Unauthorized', 401);

    // Fetch hotel global aiMode
    const hotel = await prisma.hotel.findUnique({
      where: { id: hotelId },
      select: { aiMode: true },
    }).catch(() => null);

    let rules = await prisma.aiRule.findMany({
      where: { hotelId },
      orderBy: { id: 'asc' },
    });

    // Seed default rules for this hotel if empty
    if (!rules || rules.length === 0) {
      for (const def of DEFAULT_AI_RULES) {
        await prisma.aiRule.upsert({
          where: {
            hotelId_topic: {
              hotelId,
              topic: def.topic,
            },
          },
          update: {},
          create: {
            hotelId,
            topic: def.topic,
            mode: def.mode,
            note: def.note,
          },
        }).catch(() => {});
      }

      rules = await prisma.aiRule.findMany({
        where: { hotelId },
        orderBy: { id: 'asc' },
      });
    }

    return successResponse(
      res,
      {
        aiMode: hotel?.aiMode || 'Autonomous',
        rules,
      },
      'AI Rules'
    );
  } catch (error) {
    next(error);
  }
};

export const updateAiRules = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Authentication required: missing hotel identifier', 401);
    }

    const { aiMode, rules } = req.body;

    // Validate and update global aiMode if provided
    if (aiMode !== undefined) {
      if (!VALID_GLOBAL_MODES.includes(aiMode)) {
        return errorResponse(res, `Invalid aiMode. Must be one of: ${VALID_GLOBAL_MODES.join(', ')}`, 400);
      }
      await prisma.hotel.update({
        where: { id: hotelId },
        data: { aiMode },
      }).catch(() => {});
    }

    // Validate and upsert topic rules if provided
    if (rules && Array.isArray(rules)) {
      for (const r of rules) {
        if (!r.topic) continue;
        const normalizedMode = MODE_MAP[r.mode];
        if (!normalizedMode) {
          return errorResponse(
            res,
            `Invalid mode '${r.mode}' for topic '${r.topic}'. Allowed: Autonomous, Human Approval, Always Escalate (or Auto, Approve, Escalate)`,
            400
          );
        }

        await prisma.aiRule.upsert({
          where: {
            hotelId_topic: {
              hotelId,
              topic: r.topic,
            },
          },
          update: {
            mode: normalizedMode,
            note: r.note !== undefined ? r.note : undefined,
          },
          create: {
            hotelId,
            topic: r.topic,
            mode: normalizedMode,
            note: r.note || '',
          },
        });
      }
    }

    // Return updated state for this hotel
    const [updatedHotel, updatedRules] = await Promise.all([
      prisma.hotel.findUnique({ where: { id: hotelId }, select: { aiMode: true } }).catch(() => null),
      prisma.aiRule.findMany({ where: { hotelId }, orderBy: { id: 'asc' } }),
    ]);

    return successResponse(
      res,
      {
        aiMode: updatedHotel?.aiMode || aiMode || 'Autonomous',
        rules: updatedRules,
      },
      'AI Rules updated successfully'
    );
  } catch (error) {
    next(error);
  }
};

export const getKnowledgeDocs = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) return errorResponse(res, 'Unauthorized', 401);
    const docs = await prisma.knowledgeDoc.findMany({
      where: { hotelId },
      orderBy: { updatedAt: 'desc' },
    });
    return successResponse(res, docs, 'Knowledge documents');
  } catch (error) {
    next(error);
  }
};
