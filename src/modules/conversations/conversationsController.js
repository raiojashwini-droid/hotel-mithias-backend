import { prisma } from '../../config/database.js';
import { errorResponse, successResponse } from '../../utils/response.js';
import { emailService } from '../email/emailService.js';
import { sendMetaWhatsAppMessage } from '../whatsapp/whatsappController.js';

export const getConversations = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { channel, stage, aiStatus } = req.query;
    const where = {
      guest: { hotelId },
    };
    if (channel) where.primaryChannel = channel;
    if (stage) where.stage = stage;
    if (aiStatus) where.aiStatus = aiStatus;

    const conversations = await prisma.conversation.findMany({
      where,
      include: {
        guest: {
          include: { reservations: true },
        },
        messages: {
          orderBy: { at: 'asc' },
        },
      },
      orderBy: { lastAt: 'desc' },
    });

    const allHotelReservations = await prisma.reservation.findMany({
      where: { hotelId },
      include: {
        guest: {
          select: { room: true },
        },
      },
    });

    const parsed = conversations.map((c) => {
      let resObj = c.guest?.reservations?.[0] || null;
      if (!resObj && allHotelReservations.length > 0) {
        if (c.guest?.room) {
          resObj = allHotelReservations.find((r) => r.guest?.room === c.guest.room) || null;
        }
        if (!resObj && c.guest?.name) {
          resObj = allHotelReservations.find((r) => r.guestId === c.guest.id || r.mewsId === c.guest.mewsId) || null;
        }
      }

      return {
        ...c,
        channels: c.primaryChannel ? [c.primaryChannel] : ['whatsapp'],
        knowledgeUsed: JSON.parse(c.knowledgeUsed || '[]'),
        upsellIdeas: JSON.parse(c.upsellIdeas || '[]'),
        escalation: (() => {
          if (!c.escalation) return undefined;
          try {
            return JSON.parse(c.escalation);
          } catch {
            return undefined;
          }
        })(),
        guest: {
          ...c.guest,
          tags: JSON.parse(c.guest?.tags || '[]'),
          reservation: resObj,
        },
        messages: (c.messages || []).map((m) => ({
          ...m,
          knowledge: JSON.parse(m.knowledge || '[]'),
          buttons: JSON.parse(m.buttons || '[]'),
        })),
      };
    });

    return successResponse(res, parsed, 'Conversations list');
  } catch (error) {
    next(error);
  }
};

export const getConversationById = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { id } = req.params;
    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        guest: { hotelId },
      },
      include: {
        guest: {
          include: { reservations: true },
        },
        messages: {
          orderBy: { at: 'asc' },
        },
      },
    });

    if (!conversation) {
      return errorResponse(res, 'Conversation not found', 404);
    }

    let resObj = conversation.guest?.reservations?.[0] || null;
    if (!resObj) {
      if (conversation.guest?.room) {
        resObj = await prisma.reservation.findFirst({
          where: {
            hotelId,
            guest: {
              room: conversation.guest.room,
            },
          },
        });
      }
      if (!resObj && conversation.guest?.id) {
        resObj = await prisma.reservation.findFirst({ where: { hotelId, guestId: conversation.guest.id } });
      }
    }

    const parsed = {
      ...conversation,
      channels: conversation.primaryChannel ? [conversation.primaryChannel] : ['whatsapp'],
      knowledgeUsed: JSON.parse(conversation.knowledgeUsed || '[]'),
      upsellIdeas: JSON.parse(conversation.upsellIdeas || '[]'),
      taskIds: JSON.parse(conversation.taskIds || '[]'),
      escalation: (() => {
        if (!conversation.escalation) return undefined;
        try {
          return JSON.parse(conversation.escalation);
        } catch {
          return undefined;
        }
      })(),
      guest: {
        ...conversation.guest,
        tags: JSON.parse(conversation.guest?.tags || '[]'),
        reservation: resObj,
      },
      messages: (conversation.messages || []).map((m) => ({
        ...m,
        knowledge: JSON.parse(m.knowledge || '[]'),
        buttons: JSON.parse(m.buttons || '[]'),
      })),
    };

    return successResponse(res, parsed, 'Conversation details');
  } catch (error) {
    next(error);
  }
};

export const sendReply = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { id } = req.params;
    const { body, staffName = 'Amélie Duprez', channel } = req.body;

    if (!body) {
      return errorResponse(res, 'Message body is required', 400);
    }

    const conv = await prisma.conversation.findFirst({
      where: {
        id,
        guest: { hotelId },
      },
      include: { guest: true },
    });
    if (!conv) {
      return errorResponse(res, 'Conversation not found', 404);
    }

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const msgId = `m-${Date.now()}`;
    const targetChannel = channel || conv.primaryChannel || 'email';

    const message = await prisma.message.create({
      data: {
        id: msgId,
        conversationId: id,
        author: 'staff',
        channel: targetChannel,
        body,
        at: timeStr,
        staffName,
      },
    });

    await prisma.conversation.update({
      where: { id },
      data: {
        lastAt: timeStr,
        aiStatus: 'human-takeover',
        suggestedReply: '',
        unread: 0,
      },
    });

    // Real Outbound Email Dispatch via Gmail API
    if (targetChannel === 'email') {
      let toEmail = req.body.toEmail;
      if (!toEmail) {
        if (conv.guest?.email) {
          toEmail = conv.guest.email;
        } else if (conv.subject && conv.subject.includes('@')) {
          toEmail = conv.subject;
        }
      }
      if (toEmail) {
        emailService.sendGuestEmail({
          hotelId,
          conversationId: id,
          toEmail,
          subject: conv.subject || 'Message from Hotel Reception',
          text: body,
          author: 'staff',
        }).catch((err) => {
          console.warn('[SendReply Outbound Email Warning]:', err.message);
        });
      }
    } else if (targetChannel === 'whatsapp') {
      const guestPhone = conv.guest?.phone;
      if (guestPhone) {
        sendMetaWhatsAppMessage(guestPhone, body, [], hotelId).catch((err) => {
          console.warn('[SendReply Outbound WhatsApp Warning]:', err.message);
        });
      }
    }

    await prisma.activityItem.create({
      data: {
        id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        hotelId,
        at: timeStr,
        kind: 'reply',
        text: `Staff reply sent to ${conv.guest.name}`,
        meta: staffName,
      },
    }).catch(() => {});

    return successResponse(res, message, 'Reply sent');
  } catch (error) {
    next(error);
  }
};

export const toggleTakeover = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { id } = req.params;
    const { aiStatus } = req.body;

    const conv = await prisma.conversation.findFirst({
      where: { id, guest: { hotelId } },
      include: { guest: true },
    });
    if (!conv) {
      return errorResponse(res, 'Conversation not found', 404);
    }

    const newStatus = aiStatus || (conv.aiStatus === 'ai-handling' ? 'human-takeover' : 'ai-handling');

    const updated = await prisma.conversation.update({
      where: { id },
      data: { aiStatus: newStatus },
    });

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    await prisma.activityItem.create({
      data: {
        id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        hotelId,
        at: timeStr,
        kind: newStatus === 'human-takeover' ? 'takeover' : 'system',
        text: newStatus === 'human-takeover' ? `Staff takeover for ${conv.guest.name}` : `AI resumed for ${conv.guest.name}`,
        meta: newStatus,
      },
    }).catch(() => {});

    return successResponse(res, { id, aiStatus: updated.aiStatus }, `AI Mode updated to ${updated.aiStatus}`);
  } catch (error) {
    next(error);
  }
};

export const escalateConversation = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { id } = req.params;
    const { reason = 'Escalated by Front Office', urgency = 'High', suggested = 'Review guest request' } = req.body;

    const conv = await prisma.conversation.findFirst({
      where: { id, guest: { hotelId } },
      include: { guest: true },
    });
    if (!conv) {
      return errorResponse(res, 'Conversation not found', 404);
    }

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const escalationData = {
      reason,
      urgency,
      suggested,
      raisedAt: timeStr,
    };

    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        aiStatus: 'escalated',
        escalation: JSON.stringify(escalationData),
      },
    });

    await prisma.activityItem.create({
      data: {
        id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        hotelId,
        at: timeStr,
        kind: 'escalation',
        text: `Conversation escalated: ${reason}`,
        meta: conv.guest.name,
      },
    }).catch(() => {});

    return successResponse(res, { id, aiStatus: 'escalated', escalation: escalationData }, 'Conversation escalated');
  } catch (error) {
    next(error);
  }
};

export const resolveConversation = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { id } = req.params;

    const conv = await prisma.conversation.findFirst({
      where: { id, guest: { hotelId } },
      include: { guest: true },
    });
    if (!conv) {
      return errorResponse(res, 'Conversation not found', 404);
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        aiStatus: 'resolved',
        unread: 0,
      },
    });

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    await prisma.activityItem.create({
      data: {
        id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        hotelId,
        at: timeStr,
        kind: 'resolve',
        text: `Conversation resolved for ${conv.guest.name}`,
        meta: 'Front Office',
      },
    }).catch(() => {});

    return successResponse(res, { id, aiStatus: 'resolved' }, 'Conversation resolved');
  } catch (error) {
    next(error);
  }
};

export const receiveGuestMessage = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { id } = req.params;
    const { body, channel = 'whatsapp' } = req.body;


    if (!body) {
      return errorResponse(res, 'Message body is required', 400);
    }

    const conv = await prisma.conversation.findFirst({
      where: { id, guest: { hotelId } },
      include: { guest: true },
    });
    if (!conv) {
      return errorResponse(res, 'Conversation not found', 404);
    }

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const msgId = `m-${Date.now()}`;

    // 1. Record Guest Message
    const guestMsg = await prisma.message.create({
      data: {
        id: msgId,
        conversationId: id,
        author: 'guest',
        channel,
        body,
        at: timeStr,
      },
    });

    await prisma.conversation.update({
      where: { id },
      data: {
        lastAt: timeStr,
        unread: (conv.unread || 0) + 1,
      },
    });

    // 2. If AI handling is active, process with AI service
    let aiResult = null;
    if (conv.aiStatus === 'ai-handling') {
      const { processGuestMessageAI } = await import('./aiService.js');
      aiResult = await processGuestMessageAI({
        messageText: body,
        conversationId: id,
        hotelId,
        channel,
      });
    }

    return successResponse(
      res,
      { guestMessage: guestMsg, aiResult },
      'Guest message processed successfully',
      201,
    );
  } catch (error) {
    next(error);
  }
};

