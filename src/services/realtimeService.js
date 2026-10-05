/**
 * Realtime Event Streaming Service (SSE - Server-Sent Events)
 * Manages connected frontend clients, heartbeats, and zero-refresh live broadcasting.
 */

// Map of hotelId -> Set of active Express Response objects
const hotelClients = new Map();

// Periodic heartbeat to keep connections alive and prevent proxy timeouts (25s)
let heartbeatInterval = null;

function ensureHeartbeat() {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    for (const [hotelId, clients] of hotelClients.entries()) {
      if (clients.size === 0) {
        hotelClients.delete(hotelId);
        continue;
      }
      for (const res of clients) {
        try {
          res.write(': ping\n\n');
        } catch (err) {
          clients.delete(res);
        }
      }
    }
  }, 25000);

  if (heartbeatInterval.unref) {
    heartbeatInterval.unref();
  }
}

export const realtimeService = {
  /**
   * Register a new SSE client connection
   */
  subscribe(hotelId, req, res) {
    const targetHotelId = hotelId || 'hotel-mercier';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });

    res.write(`: connected to hotelogx realtime stream [hotel: ${targetHotelId}]\n\n`);

    if (!hotelClients.has(targetHotelId)) {
      hotelClients.set(targetHotelId, new Set());
    }

    const clientSet = hotelClients.get(targetHotelId);
    clientSet.add(res);

    ensureHeartbeat();

    // Clean up on client disconnect
    req.on('close', () => {
      clientSet.delete(res);
      if (clientSet.size === 0) {
        hotelClients.delete(targetHotelId);
      }
    });

    req.on('error', () => {
      clientSet.delete(res);
      if (clientSet.size === 0) {
        hotelClients.delete(targetHotelId);
      }
    });
  },

  /**
   * Broadcast an event to all connected dashboard clients of a specific hotel
   */
  broadcastToHotel(hotelId, eventType, data = {}) {
    const targetHotelId = hotelId || 'hotel-mercier';
    const payload = `event: ${eventType}\ndata: ${JSON.stringify({ ...data, timestamp: new Date().toISOString() })}\n\n`;

    const targets = [targetHotelId];

    let dispatchedCount = 0;
    for (const id of targets) {
      const clients = hotelClients.get(id);
      if (clients && clients.size > 0) {
        for (const res of clients) {
          try {
            res.write(payload);
            dispatchedCount++;
          } catch (err) {
            clients.delete(res);
          }
        }
      }
    }

    return dispatchedCount;
  },

  /**
   * Get active connection stats for diagnostics
   */
  getStats() {
    const stats = {};
    for (const [hotelId, clients] of hotelClients.entries()) {
      stats[hotelId] = clients.size;
    }
    return stats;
  },
};
