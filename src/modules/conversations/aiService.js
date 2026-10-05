import { prisma } from '../../config/database.js';
import { pmsService } from '../pms/pmsService.js';
import { emailService } from '../email/emailService.js';

/**
 * Common stop words for keyword extraction
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'what', 'when', 'where', 'which', 'who', 'how', 'why',
  'can', 'could', 'would', 'will', 'you', 'your', 'our', 'are', 'was', 'were',
  'have', 'has', 'had', 'does', 'did', 'about', 'from', 'this', 'that', 'there',
  'please', 'tell', 'want', 'need', 'give', 'know', 'some', 'any', 'much', 'many',
  'hotel', 'room', 'time', 'stay', 'available', 'policy', 'rules'
]);

/**
 * Housekeeping intent keywords map and dictionary
 */
const HOUSEKEEPING_PATTERNS = [
  { regex: /\b(towel|towels|bath towel|hand towel|face towel)\b/i, item: 'Fresh towels', priority: 'Normal' },
  { regex: /\b(pillow|pillows|extra pillow|feather pillow)\b/i, item: 'Extra pillows', priority: 'Normal' },
  { regex: /\b(blanket|blankets|duvet|bedsheet|bed sheet|linen)\b/i, item: 'Extra bedding / blanket', priority: 'Normal' },
  { regex: /\b(baby cot|cot|crib|baby bed)\b/i, item: 'Baby cot setup', priority: 'High' },
  { regex: /\b(toiletries|shampoo|conditioner|soap|body wash|shower gel)\b/i, item: 'Toiletries replenishment', priority: 'Normal' },
  { regex: /\b(dental kit|toothbrush|toothpaste|shaving kit|razor)\b/i, item: 'Dental / vanity kit', priority: 'Normal' },
  { regex: /\b(slipper|slippers|bathrobe|robe)\b/i, item: 'Bathrobes & slippers', priority: 'Normal' },
  { regex: /\b(water bottle|bottles of water|drinking water)\b/i, item: 'Complimentary water bottles', priority: 'Normal' },
  { regex: /\b(iron|ironing board|steamer)\b/i, item: 'Iron & ironing board', priority: 'Normal' },
  { regex: /\b(clean|cleaning|clean my room|housekeeping|make up room|service room)\b/i, item: 'Room cleaning service', priority: 'High' },
  { regex: /\b(trash|rubbish|garbage|empty bin|bin)\b/i, item: 'Trash clearance', priority: 'Normal' },
  { regex: /\b(toilet paper|tissue|tissues|napkins)\b/i, item: 'Tissue / toilet roll refill', priority: 'Normal' },
];

/**
 * Maintenance intent keywords
 */
const MAINTENANCE_PATTERNS = [
  { regex: /\b(ac|air condition|air conditioner|heating|hvac|thermostat|cold|hot)\b/i, issue: 'AC / Climate control issue' },
  { regex: /\b(leak|leaking|tap|faucet|drain|clogged|plumbing|flush|toilet|pipe|shower)\b/i, issue: 'Plumbing / leak issue' },
  { regex: /\b(tv|television|remote|channels|wifi|internet|connection)\b/i, issue: 'TV / Media connectivity issue' },
  { regex: /\b(light|bulb|lamp|electricity|power|socket|plug)\b/i, issue: 'Electrical / lighting issue' },
  { regex: /\b(lock|key|keycard|safe|door)\b/i, issue: 'Door lock / in-room safe issue' },
  { regex: /\b(broken|damage|damaged|not working|repair|fix)\b/i, issue: 'General maintenance / repair' },
];

/**
 * Format current time as HH:MM
 */
function getClockTime(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Calculate due time (minutes added to current time)
 */
function getDueTime(minutesToAdd = 20) {
  const d = new Date(Date.now() + minutesToAdd * 60 * 1000);
  return getClockTime(d);
}

/**
 * Extract room number from message or reservation context
 */
export function extractRoomNumber(messageText = '', conversation = null, guest = null) {
  const match = messageText.match(/room\s*#?\s*(\d{2,4})/i) || messageText.match(/\b(\d{3,4})\b/);
  if (match?.[1]) {
    return match[1];
  }
  if (guest?.reservations?.[0]?.room) {
    return guest.reservations[0].room;
  }
  if (guest?.room) {
    return guest.room;
  }
  return null;
}

/**
 * RAG Knowledge Retrieval Layer:
 * Retrieves relevant KnowledgeChunk records and hotel profile policies for a specific hotelId
 */
export async function retrieveRelevantKnowledge(hotelId, queryText) {
  if (!hotelId || !queryText) {
    return { chunks: [], docNames: [], contextText: '', hasKnowledge: false };
  }

  try {
    const rawWords = queryText
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));

    // 1. Fetch chunks strictly filtered by hotelId for tenant isolation
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { hotelId },
      include: {
        knowledgeDoc: {
          select: { name: true, category: true },
        },
      },
      take: 50,
    });

    // 2. Fetch baseline hotel profile (check-in, check-out, amenities, contacts)
    const hotel = await prisma.hotel.findUnique({
      where: { id: hotelId },
      select: {
        name: true,
        checkIn: true,
        checkOut: true,
        phone: true,
        email: true,
        website: true,
        description: true,
      },
    }).catch(() => null);

    const scoredChunks = [];
    for (const chunk of chunks) {
      const contentLower = chunk.content.toLowerCase();
      let score = 0;
      for (const word of rawWords) {
        if (contentLower.includes(word)) {
          score += 2;
        }
      }
      if (score > 0) {
        scoredChunks.push({
          ...chunk,
          score,
          docName: chunk.knowledgeDoc?.name || 'Hotel Policy',
        });
      }
    }

    scoredChunks.sort((a, b) => b.score - a.score);
    const topChunks = scoredChunks.slice(0, 3);
    const docNames = [...new Set(topChunks.map((c) => c.docName))];

    let contextText = '';
    if (hotel) {
      contextText += `Hotel Profile Baseline:\n- Hotel: ${hotel.name}\n- Check-in Time: ${hotel.checkIn}\n- Check-out Time: ${hotel.checkOut}\n- Contact Phone: ${hotel.phone}\n- Contact Email: ${hotel.email}\n- Description: ${hotel.description || 'Boutique hotel'}\n\n`;
    }

    if (topChunks.length > 0) {
      contextText += `Relevant Stored Hotel Policy Documents:\n` + topChunks.map((c, i) => `[Source ${i + 1}: ${c.docName}]\n${c.content}`).join('\n\n');
    }

    return {
      chunks: topChunks,
      docNames,
      contextText,
      hotelProfile: hotel,
      hasKnowledge: topChunks.length > 0 || Boolean(hotel),
    };
  } catch (err) {
    console.warn('[RAG Retrieval Warning]:', err.message);
    return { chunks: [], docNames: [], contextText: '', hotelProfile: null, hasKnowledge: false };
  }
}

/**
 * Generate intelligent hotel reply using OpenAI API
 */
export async function generateWithGemini({ prompt, systemInstruction = '' }) {
  // 1. Try OpenAI if OPENAI_API_KEY is configured
  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) {
    const openAiModels = ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'];
    for (const model of openAiModels) {
      try {
        const messages = [];
        if (systemInstruction) {
          messages.push({ role: 'system', content: systemInstruction });
        }
        messages.push({ role: 'user', content: prompt });

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openAiKey.trim()}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.7,
            max_tokens: 300,
          }),
          signal: AbortSignal.timeout(4000),
        });

        if (res.ok) {
          const data = await res.json();
          const reply = data?.choices?.[0]?.message?.content?.trim();
          if (reply) return reply;
        } else {
          const errData = await res.json().catch(() => ({}));
          console.warn(`[OpenAI API] Error with model ${model}:`, errData?.error?.message || res.statusText);
          if (res.status === 401 || res.status === 403 || res.status === 429) {
            break;
          }
        }
      } catch (err) {
        console.warn(`[OpenAI API] Network error with model ${model}:`, err.message);
        break;
      }
    }
  }

  return null;
}

/**
 * Detect dynamic upsell opportunities from guest inquiries and stay context
 */
export function detectUpsellOpportunities(messageText = '', conversation = null, guest = null) {
  const upsells = [];
  const text = (messageText || '').toLowerCase();

  // 1. Late checkout
  if (/\b(late check-?out|leave later|stay later|check out later|extend stay|checkout time)\b/i.test(text)) {
    upsells.push({
      label: 'Late checkout (14:00)',
      value: '€35',
      reason: 'Guest inquired about extending check-out time',
    });
  }

  // 2. Early check-in
  if (/\b(early check-?in|early arrival|arrive early|landing early|morning arrival|check in early)\b/i.test(text)) {
    upsells.push({
      label: 'Early check-in (12:00)',
      value: '€30',
      reason: 'Guest requested or inquired about arriving before standard check-in',
    });
  }

  // 3. Artisanal breakfast buffet
  if (/\b(breakfast|morning meal|buffet|dining room|coffee and croissant)\b/i.test(text)) {
    upsells.push({
      label: 'Artisanal breakfast buffet',
      value: '€22 / guest',
      reason: 'Guest mentioned or asked about breakfast service',
    });
  }

  // 4. Celebration / Champagne / Romantic
  if (/\b(champagne|wine|prosecco|celebrat|anniversary|birthday|honeymoon|romantic|flowers)\b/i.test(text)) {
    upsells.push({
      label: 'Champagne & Belgian pralines on arrival',
      value: '€55',
      reason: 'Guest mentioned celebration, romantic stay or special occasion',
    });
  }

  // 5. Secure courtyard parking
  if (/\b(parking|park|car|garage|vehicle|valet)\b/i.test(text)) {
    upsells.push({
      label: 'Secure courtyard parking',
      value: '€25 / day',
      reason: 'Guest asked about vehicle parking or garage availability',
    });
  }

  // 6. Suite upgrade
  if (/\b(upgrade|suite|better room|bigger room|junior suite|deluxe|balcony|view)\b/i.test(text)) {
    upsells.push({
      label: 'Upgrade to Junior Suite',
      value: '€45 / night',
      reason: 'Guest expressed interest in room upgrade or enhanced view',
    });
  }

  return upsells;
}

/**
 * Evaluate Hotel AI Mode & Rules for the inbound message & guest
 */
export async function evaluateAiPolicy({ hotelId, messageText, guest, intentType }) {
  let aiMode = 'Autonomous';
  let rules = [];

  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id: hotelId },
      select: { aiMode: true },
    });
    if (hotel?.aiMode) {
      aiMode = hotel.aiMode;
    }

    rules = await prisma.aiRule.findMany({
      where: { hotelId },
    });
  } catch (err) {
    console.warn('[AI Service] Policy evaluation error:', err.message);
  }

  const ruleMap = new Map();
  for (const r of rules) {
    ruleMap.set(r.topic, r.mode);
  }

  const getTopicMode = (topic, fallback = 'Autonomous') => {
    return ruleMap.get(topic) || fallback;
  };

  const text = (messageText || '').toLowerCase();

  // 1. Safety issues check (Always Escalate by default)
  if (/\b(emergency|fire|police|ambulance|injury|hurt|danger|stolen|theft|robbery)\b/i.test(text)) {
    const mode = getTopicMode('Safety issues', 'Always Escalate');
    return {
      topic: 'Safety issues',
      mode,
      requiresApproval: true,
      escalate: true,
      escalationReason: 'Safety or emergency reported by guest',
    };
  }

  // 2. Billing disputes & Refunds
  if (/\b(refund|money back|chargeback)\b/i.test(text)) {
    const mode = getTopicMode('Refunds', 'Always Escalate');
    return {
      topic: 'Refunds',
      mode,
      requiresApproval: true,
      escalate: true,
      escalationReason: 'Guest requested refund or compensation',
    };
  }
  if (/\b(dispute|overcharged|wrong charge|bill dispute|unauthorized charge)\b/i.test(text)) {
    const mode = getTopicMode('Billing disputes', 'Always Escalate');
    return {
      topic: 'Billing disputes',
      mode,
      requiresApproval: true,
      escalate: true,
      escalationReason: 'Billing dispute / folio issue',
    };
  }

  // 3. Complaints
  if (/\b(complaint|unacceptable|terrible|horrible|awful|disgusted|furious|manager|speak with manager|demand|ruined|bad service|worst)\b/i.test(text)) {
    const mode = getTopicMode('Complaints', 'Always Escalate');
    return {
      topic: 'Complaints',
      mode,
      requiresApproval: true,
      escalate: true,
      escalationReason: 'Guest dissatisfaction / complaint',
    };
  }

  // 4. VIP Guests
  if (guest?.vip) {
    const mode = getTopicMode('VIP guests', 'Human Approval');
    if (mode !== 'Autonomous') {
      return {
        topic: 'VIP guests',
        mode,
        requiresApproval: true,
        escalate: mode === 'Always Escalate',
        escalationReason: mode === 'Always Escalate' ? 'VIP guest request requires manager escalation' : undefined,
      };
    }
  }

  // 5. Late checkout / early check-in
  if (/\b(late check-?out|early check-?in|extend stay)\b/i.test(text)) {
    const mode = getTopicMode('Late checkout / early check-in', 'Human Approval');
    if (mode !== 'Autonomous') {
      return {
        topic: 'Late checkout / early check-in',
        mode,
        requiresApproval: true,
        escalate: mode === 'Always Escalate',
        escalationReason: mode === 'Always Escalate' ? 'Late checkout / early check-in escalation' : undefined,
      };
    }
  }

  // 6. Global Hotel AI Mode override
  if (aiMode === 'Suggestions Only') {
    return {
      topic: 'Global Policy',
      mode: 'Suggestions Only',
      requiresApproval: true,
      escalate: false,
    };
  }
  if (aiMode === 'Approval Required') {
    return {
      topic: 'Global Policy',
      mode: 'Approval Required',
      requiresApproval: true,
      escalate: false,
    };
  }

  // 7. Topic check based on intentType
  if (intentType === 'housekeeping') {
    const mode = getTopicMode('Housekeeping requests', 'Autonomous');
    return {
      topic: 'Housekeeping requests',
      mode,
      requiresApproval: mode !== 'Autonomous',
      escalate: mode === 'Always Escalate',
    };
  }
  if (intentType === 'maintenance') {
    const mode = getTopicMode('Maintenance reports', 'Autonomous');
    return {
      topic: 'Maintenance reports',
      mode,
      requiresApproval: mode !== 'Autonomous',
      escalate: mode === 'Always Escalate',
    };
  }
  if (intentType === 'pms_availability') {
    const mode = getTopicMode('Availability & pricing', 'Autonomous');
    return {
      topic: 'Availability & pricing',
      mode,
      requiresApproval: mode !== 'Autonomous',
      escalate: mode === 'Always Escalate',
    };
  }

  // General or Hotel Information
  const infoMode = getTopicMode('Hotel information', 'Autonomous');
  if (infoMode !== 'Autonomous') {
    return {
      topic: 'Hotel information',
      mode: infoMode,
      requiresApproval: true,
      escalate: infoMode === 'Always Escalate',
    };
  }

  return {
    topic: 'General questions',
    mode: 'Autonomous',
    requiresApproval: false,
    escalate: false,
  };
}

/**
 * Process inbound guest message, detect intent and trigger automated actions with RAG
 */
export async function processGuestMessageAI({
  messageText,
  conversationId,
  hotelId = null,
  channel = 'whatsapp',
}) {
  if (!messageText || typeof messageText !== 'string') {
    return null;
  }

  // Load conversation details with guest and reservation
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId },
    include: {
      guest: {
        include: { reservations: true },
      },
    },
  });

  if (!conversation) return null;

  const guest = conversation.guest;
  const guestName = guest?.name || 'Guest';
  const effectiveHotelId = hotelId || guest?.hotelId;
  const room = extractRoomNumber(messageText, conversation, guest) || '208';
  const timeStr = getClockTime();

  // Detect upsell opportunities
  const detectedUpsells = detectUpsellOpportunities(messageText, conversation, guest);
  if (detectedUpsells.length > 0) {
    try {
      const existingUpsells = JSON.parse(conversation.upsellIdeas || '[]');
      const existingLabels = new Set(existingUpsells.map((u) => u.label));
      const combinedUpsells = [...existingUpsells, ...detectedUpsells.filter((u) => !existingLabels.has(u.label))];
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          upsellIdeas: JSON.stringify(combinedUpsells),
          lastAt: timeStr,
        },
      });
    } catch (_) { }
  }

  // 1. Retrieve RAG Knowledge context strictly for this hotel
  const rag = await retrieveRelevantKnowledge(effectiveHotelId, messageText);
  const hotelName = rag.hotelProfile?.name || 'Hotel Front Desk';

  // 2. Check for Maintenance Intent (Checked first so leaks, broken pipes, AC issues are prioritized over routine housekeeping)
  for (const pattern of MAINTENANCE_PATTERNS) {
    if (pattern.regex.test(messageText)) {
      const policy = await evaluateAiPolicy({
        hotelId: effectiveHotelId,
        messageText,
        guest,
        intentType: 'maintenance',
      });

      const issueTitle = `${pattern.issue} in Room ${room}`;
      const issueId = `MT-${Date.now().toString().slice(-4)}`;
      const taskId = `t-${Date.now()}`;

      // Create Task for Maintenance
      const task = await prisma.task.create({
        data: {
          id: taskId,
          hotelId: effectiveHotelId,
          title: `Inspect ${pattern.issue} — Room ${room}`,
          detail: `Reported by ${guestName} via ${channel}: "${messageText.trim()}"`,
          room,
          guest: guestName,
          department: 'Maintenance',
          priority: 'High',
          status: 'New',
          createdAt: timeStr,
          due: getDueTime(20),
          source: 'AI Detection',
          conversationId,
          trail: {
            create: [
              {
                at: timeStr,
                text: `Automated AI Task created for Maintenance (${issueId})`,
                via: 'ai',
              },
            ],
          },
        },
      }).catch(() => null);

      let aiReplyBody = await generateWithGemini({
        prompt: `A hotel guest (${guestName}, Room ${room}) reported an issue: "${messageText}". Write a polite, empathetic, concise 2-sentence hotel reply apologizing for the inconvenience and stating that our maintenance team has been notified and a technician is heading to their room.`,
        systemInstruction: `You are the AI Front Desk assistant for ${hotelName}. Be warm, professional, concise, and helpful. Do not use placeholders.`,
      });

      if (!aiReplyBody) {
        aiReplyBody = `I apologize for the inconvenience regarding the ${pattern.issue.toLowerCase()} in Room ${room}. Our engineering team has been alerted immediately and a technician will visit your room shortly.`;
      }

      if (policy.requiresApproval) {
        return {
          handled: true,
          requiresApproval: true,
          aiStatus: policy.escalate ? 'escalated' : 'human-takeover',
          type: 'maintenance',
          task,
          replyText: aiReplyBody,
          suggestedReply: aiReplyBody,
          upsellIdeas: detectedUpsells,
          policy,
          escalation: policy.escalate ? {
            reason: policy.escalationReason || 'Policy escalation',
            urgency: policy.topic === 'Safety issues' ? 'Urgent' : 'High',
            raisedAt: timeStr,
            suggested: aiReplyBody,
          } : null,
        };
      }

      const aiMsg = await prisma.message.create({
        data: {
          id: `m-${Date.now()}`,
          conversationId,
          author: 'ai',
          channel,
          body: aiReplyBody,
          at: timeStr,
          confidence: 0.96,
        },
      });

      return {
        handled: true,
        requiresApproval: false,
        aiStatus: 'ai-handling',
        type: 'maintenance',
        task,
        message: aiMsg,
        replyText: aiReplyBody,
        suggestedReply: aiReplyBody,
        upsellIdeas: detectedUpsells,
        policy,
      };
    }
  }

  // 3. Check for Housekeeping Intent
  for (const pattern of HOUSEKEEPING_PATTERNS) {
    if (pattern.regex.test(messageText)) {
      const policy = await evaluateAiPolicy({
        hotelId: effectiveHotelId,
        messageText,
        guest,
        intentType: 'housekeeping',
      });

      const itemTitle = `${pattern.item} — Room ${room}`;
      const taskId = `t-${Date.now()}`;
      const dueTime = getDueTime(pattern.priority === 'High' ? 15 : 25);

      // Create Task in Database
      const task = await prisma.task.create({
        data: {
          id: taskId,
          hotelId: effectiveHotelId,
          title: itemTitle,
          detail: `Guest request via ${channel}: "${messageText.trim()}"`,
          room,
          guest: guestName,
          department: 'Housekeeping',
          priority: pattern.priority,
          status: 'New',
          createdAt: timeStr,
          due: dueTime,
          source: channel === 'whatsapp' ? 'WhatsApp' : 'Guest Chat',
          conversationId,
          trail: {
            create: [
              {
                at: timeStr,
                text: `Automated AI Task created for Housekeeping: "${pattern.item}"`,
                via: 'ai',
              },
            ],
          },
        },
        include: { trail: true },
      }).catch((err) => {
        console.error('[AI Service] Task creation error:', err.message);
        return null;
      });

      // Update Conversation taskIds array
      try {
        const existingTaskIds = JSON.parse(conversation.taskIds || '[]');
        if (!existingTaskIds.includes(taskId)) {
          existingTaskIds.push(taskId);
          await prisma.conversation.update({
            where: { id: conversationId },
            data: {
              taskIds: JSON.stringify(existingTaskIds),
              lastAt: timeStr,
            },
          });
        }
      } catch (e) {
        console.warn('[AI Service] Task IDs update warning:', e.message);
      }

      // Log Activity Feed Item
      await prisma.activityItem.create({
        data: {
          id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          hotelId: effectiveHotelId,
          at: timeStr,
          kind: 'task',
          text: `AI created task for Housekeeping: "${itemTitle}"`,
          meta: `Room ${room}`,
        },
      }).catch(() => { });

      let aiReplyBody = await generateWithGemini({
        prompt: `A hotel guest (${guestName}, Room ${room}) sent this message: "${messageText}". Write a polite, warm, concise 2-sentence hotel reply letting them know we have dispatched housekeeping with their ${pattern.item.toLowerCase()} right away.`,
        systemInstruction: `You are the AI Front Desk assistant for ${hotelName}. Be warm, professional, concise, and helpful. Do not use placeholders.`,
      });

      if (!aiReplyBody) {
        aiReplyBody = `Certainly, ${guestName.split(' ')[0] || 'Sir/Madam'}. I have logged your request for ${pattern.item.toLowerCase()} for Room ${room}. Our housekeeping team has been dispatched and will attend to this promptly.`;
      }

      if (policy.requiresApproval) {
        return {
          handled: true,
          requiresApproval: true,
          aiStatus: policy.escalate ? 'escalated' : 'human-takeover',
          type: 'housekeeping',
          task,
          replyText: aiReplyBody,
          suggestedReply: aiReplyBody,
          upsellIdeas: detectedUpsells,
          policy,
          escalation: policy.escalate ? {
            reason: policy.escalationReason || 'Policy escalation',
            urgency: policy.topic === 'Safety issues' ? 'Urgent' : 'High',
            raisedAt: timeStr,
            suggested: aiReplyBody,
          } : null,
        };
      }

      // Save AI Message in Conversation if autonomous
      const aiMsg = await prisma.message.create({
        data: {
          id: `m-${Date.now()}`,
          conversationId,
          author: 'ai',
          channel,
          body: aiReplyBody,
          at: timeStr,
          confidence: 0.98,
        },
      });

      return {
        handled: true,
        requiresApproval: false,
        aiStatus: 'ai-handling',
        type: 'housekeeping',
        task,
        message: aiMsg,
        replyText: aiReplyBody,
        suggestedReply: aiReplyBody,
        upsellIdeas: detectedUpsells,
        policy,
      };
    }
  }

  // 4. Check for Room Availability & Pre-Arrival Booking Inquiry
  const isAvailabilityInquiry = /\b(availability|available room|rooms available|book a room|booking|rates|rate|price|pricing|vacancy|vacant|cost per night)\b/i.test(messageText);
  if (isAvailabilityInquiry) {
    const policy = await evaluateAiPolicy({
      hotelId: effectiveHotelId,
      messageText,
      guest,
      intentType: 'pms_availability',
    });

    const pmsAvail = await pmsService.checkAvailability(effectiveHotelId);
    const bookingUrl = pmsAvail.bookingEngine || 'https://booking.hotelmercier.be';
    const categoriesText = (pmsAvail.categories || []).map((c) => `- ${c.name}: ${c.rate}`).join('\n');

    let aiReplyBody = await generateWithGemini({
      prompt: `A guest asked about room availability and rates: "${messageText}".
Live Hotel Availability & Rates from PMS:
${categoriesText}
Direct Booking Engine Link: ${bookingUrl}
Write a polite, warm 2-3 sentence response confirming availability, mentioning starting rates, and inviting them to book directly on our website (${bookingUrl}). Never ask for credit card info or confirm reservations directly in chat.`,
      systemInstruction: `You are the AI Assistant for ${hotelName}. Be warm, welcoming, and concise. Availability and rates are read from PMS. Direct booking ends with a link to the hotel website.`,
    });

    if (!aiReplyBody) {
      aiReplyBody = `We have rooms available for your stay! Our Deluxe Courtyard rooms start from €160/night and Superior King from €185/night. You can view full availability and reserve directly on our website here: ${bookingUrl}`;
    }

    if (policy.requiresApproval) {
      return {
        handled: true,
        requiresApproval: true,
        aiStatus: policy.escalate ? 'escalated' : 'human-takeover',
        type: 'pms_availability',
        replyText: aiReplyBody,
        suggestedReply: aiReplyBody,
        upsellIdeas: detectedUpsells,
        policy,
        escalation: policy.escalate ? {
          reason: policy.escalationReason || 'Policy escalation',
          urgency: policy.topic === 'Safety issues' ? 'Urgent' : 'High',
          raisedAt: timeStr,
          suggested: aiReplyBody,
        } : null,
      };
    }

    const aiMsg = await prisma.message.create({
      data: {
        id: `m-${Date.now()}`,
        conversationId,
        author: 'ai',
        channel,
        body: aiReplyBody,
        at: timeStr,
        confidence: 0.99,
      },
    });

    return {
      handled: true,
      requiresApproval: false,
      aiStatus: 'ai-handling',
      type: 'pms_availability',
      message: aiMsg,
      replyText: aiReplyBody,
      suggestedReply: aiReplyBody,
      upsellIdeas: detectedUpsells,
      policy,
    };
  }

  // 5. Hotel Policies, FAQs & General Questions with RAG
  const policy = await evaluateAiPolicy({
    hotelId: effectiveHotelId,
    messageText,
    guest,
    intentType: rag.docNames.length > 0 ? 'knowledge_rag' : 'general',
  });

  const ragPrompt = `A hotel guest (${guestName}, Room ${room}) asked: "${messageText}".
${rag.contextText ? `\nVerified Hotel Information & Stored Policies:\n${rag.contextText}\n` : ''}
Write a polite, accurate, concise 1-3 sentence response directly answering their question based on the verified hotel policies above.
- If asking about check-in, check-out, breakfast, parking, wifi, cancellation, or pets, state the exact hours/details from the policies.
- If the exact answer is not in the documents, give a warm front-desk assistance reply and offer to help.`;

  const ragSystem = `You are the AI Front Desk Assistant for ${hotelName}. Be warm, professional, and strictly accurate to the hotel's policies. Do not invent contradictory policies. Do not use placeholders.`;

  let replyText = await generateWithGemini({
    prompt: ragPrompt,
    systemInstruction: ragSystem,
  });

  // Contextual Fallback if Gemini API is offline or returns null
  if (!replyText) {
    const lower = messageText.toLowerCase();
    if (lower.includes('check-in') || lower.includes('check in') || lower.includes('arrival')) {
      const ci = rag.hotelProfile?.checkIn || '15:00';
      const co = rag.hotelProfile?.checkOut || '11:00';
      replyText = `Our standard check-in time is from ${ci}, and check-out is until ${co}. If you require an early check-in or late check-out, please let us know and we will be delighted to assist you.`;
    } else if (lower.includes('check-out') || lower.includes('checkout') || lower.includes('departure')) {
      const co = rag.hotelProfile?.checkOut || '11:00';
      replyText = `Check-out time is until ${co}. Late check-out can be arranged upon request subject to availability.`;
    } else if (lower.includes('breakfast')) {
      replyText = `Breakfast is served daily in our dining room starting at 07:00. We offer a buffet featuring fresh local Belgian pastries, artisanal cheeses, fruit, and hot beverages.`;
    } else if (lower.includes('wifi') || lower.includes('wi-fi') || lower.includes('internet')) {
      const wifiName = `${(rag.hotelProfile?.name || 'Hotel').replace(/\s+/g, '')}-Guest`;
      replyText = `High-speed complimentary Wi-Fi is available throughout the hotel. You can connect to '${wifiName}' with no password required.`;
    } else if (lower.includes('pet') || lower.includes('dog') || lower.includes('cat')) {
      replyText = `Small well-behaved pets are welcome at our property upon advance notice. Please inform the front desk so we can prepare pet amenities for your room.`;
    } else if (rag.chunks.length > 0) {
      const snippet = rag.chunks[0].content.slice(0, 150).trim();
      replyText = `Regarding your inquiry: "${snippet}..." Our front desk team is also available 24/7 if you have further questions.`;
    } else {
      replyText = `Thank you for your message, ${guestName.split(' ')[0] || 'Guest'}. Our front office team at ${hotelName} is at your service. Please let us know if you need anything specific for your stay.`;
    }
  }

  // 6. Persist Knowledge Used in Conversation
  if (rag.docNames.length > 0) {
    try {
      const existingKnowledge = JSON.parse(conversation.knowledgeUsed || '[]');
      const updatedKnowledge = [...new Set([...existingKnowledge, ...rag.docNames])];
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          knowledgeUsed: JSON.stringify(updatedKnowledge),
          lastAt: timeStr,
        },
      });
    } catch (_) { }
  }

  if (policy.requiresApproval) {
    return {
      handled: true,
      requiresApproval: true,
      aiStatus: policy.escalate ? 'escalated' : 'human-takeover',
      type: rag.docNames.length > 0 ? 'knowledge_rag' : 'general',
      replyText,
      suggestedReply: replyText,
      knowledgeUsed: rag.docNames,
      upsellIdeas: detectedUpsells,
      policy,
      escalation: policy.escalate ? {
        reason: policy.escalationReason || 'Policy escalation',
        urgency: policy.topic === 'Safety issues' ? 'Urgent' : 'High',
        raisedAt: timeStr,
        suggested: replyText,
      } : null,
    };
  }

  const aiMsg = await prisma.message.create({
    data: {
      id: `m-${Date.now()}`,
      conversationId,
      author: 'ai',
      channel,
      body: replyText,
      at: timeStr,
      knowledge: JSON.stringify(rag.docNames),
      confidence: rag.docNames.length > 0 ? 0.95 : 0.90,
    },
  });

  if (channel === 'email') {
    const toEmail = conversation.guest?.email || (conversation.subject && conversation.subject.includes('@') ? conversation.subject : null);
    if (toEmail) {
      emailService.sendGuestEmail({
        hotelId: effectiveHotelId,
        conversationId,
        toEmail,
        subject: conversation.subject || 'Message from Hotel Reception',
        text: replyText,
        author: 'ai',
      }).catch((err) => {
        console.warn('[AI Service Outbound Email Warning]:', err.message);
      });
    } else {
      console.warn(`[AI Service] No recipient email found for conversation ${conversationId}, skipping outbound email`);
    }
  }

  return {
    handled: true,
    requiresApproval: false,
    aiStatus: 'ai-handling',
    type: rag.docNames.length > 0 ? 'knowledge_rag' : 'general',
    message: aiMsg,
    replyText,
    suggestedReply: replyText,
    knowledgeUsed: rag.docNames,
    upsellIdeas: detectedUpsells,
    policy,
  };
}
