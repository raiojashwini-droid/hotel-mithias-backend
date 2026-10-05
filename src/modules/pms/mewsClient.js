/**
 * Official Mews Connector API Client wrapper (Production-Grade & High Performance)
 */

// In-memory catalog cache with 10-minute TTL to eliminate redundant Mews API calls
const catalogCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

// Official Mews API Server Endpoints
const OFFICIAL_MEWS_SERVERS = [
  'https://api.mews.com',
  'https://api.mews-demo.com',
  'https://api.mews.li',
];

export class MewsClient {
  constructor() {
    this.clientToken = (process.env.MEWS_CLIENT_TOKEN || '').trim();
    this.systemAccessToken = (process.env.MEWS_ACCESS_TOKEN || '').trim();
    
    // Normalize configured URL if provided
    const configuredUrl = (process.env.MEWS_API_URL || '')
      .replace(/\/api\/connector\/v1\/?$/, '')
      .replace(/\/+$/, '');
    
    // Build ordered candidate list (Configured URL -> Production -> Demo -> Regional)
    const candidates = [];
    if (configuredUrl) candidates.push(configuredUrl);
    for (const s of OFFICIAL_MEWS_SERVERS) {
      if (!candidates.includes(s)) candidates.push(s);
    }
    this.candidateUrls = candidates;
    this.baseUrl = configuredUrl || 'https://api.mews-demo.com';
    this.cachedStayServiceId = (process.env.MEWS_STAY_SERVICE_ID || '').trim() || null;
  }

  /**
   * Resolve token-specific cache entry
   */
  _getCached(token) {
    if (!token) return null;
    const entry = catalogCache.get(token);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      catalogCache.delete(token);
      return null;
    }
    return entry;
  }

  _setCached(token, data) {
    if (!token) return;
    const existing = catalogCache.get(token) || {};
    catalogCache.set(token, {
      ...existing,
      ...data,
      timestamp: Date.now(),
    });
  }

  /**
   * Helper method to send authenticated POST requests to Mews API
   * Automatically routes to token's verified live server (Production vs Demo).
   */
  async _post(path, accessToken, payload = {}, options = {}) {
    const overrideBaseUrl = typeof options === 'string' ? options : options.overrideBaseUrl;
    const isProbe = typeof options === 'object' && Boolean(options.isProbe);

    const clientToken = (this.clientToken || '').trim();
    if (!clientToken) {
      throw new Error('MEWS_CLIENT_TOKEN environment variable is not configured');
    }

    const token = (accessToken !== undefined && accessToken !== null && String(accessToken).trim() !== '')
      ? String(accessToken).trim()
      : this.systemAccessToken;
    if (!token || token.trim().length < 4) {
      throw new Error('Valid Mews Access Token or property credential is required');
    }

    // Determine target base URL (Override -> Token-specific resolved URL -> Default baseUrl)
    const cachedEntry = this._getCached(token);
    const activeBaseUrl = overrideBaseUrl || cachedEntry?.resolvedBaseUrl || this.baseUrl;

    const cleanPath = path.startsWith('/api/connector/v1')
      ? path
      : `/api/connector/v1${path.startsWith('/') ? path : `/${path}`}`;
    const endpoint = `${activeBaseUrl}${cleanPath}`;
    const httpFetch = globalThis.fetch || fetch;

    const requestBody = {
      ClientToken: clientToken,
      AccessToken: token.trim(),
      Client: 'HotelPlatform 1.0.0',
      ...payload,
    };

    const maxAttempts = isProbe ? 1 : 3;
    const backoffs = [1500, 3000, 5000];
    const timeoutMs = isProbe ? 5000 : 10000;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await httpFetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
        });

        // Handle HTTP 429 Rate Limiting
        if (response.status === 429) {
          if (isProbe) {
            const err = new Error('Rate limited on candidate server');
            err.status = 429;
            throw err;
          }
          const retryAfterHeader = response.headers?.get ? response.headers.get('Retry-After') : null;
          let delay = backoffs[attempt - 1] || 3000;
          if (retryAfterHeader) {
            const parsed = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsed) && parsed > 0) {
              delay = Math.max(delay, (parsed + 1) * 1000);
            }
          }
          console.warn(`[MewsClient] HTTP 429 Rate limited on ${cleanPath}. Retrying attempt ${attempt}/${maxAttempts} in ${delay}ms...`);
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }

        if (!response.ok) {
          let errorMessage = `Mews API returned HTTP ${response.status}`;
          try {
            const errData = await response.json();
            if (errData && (errData.Message || errData.message)) {
              errorMessage = `Mews API Error: ${errData.Message || errData.message}`;
            }
          } catch {
            // ignore json parse error
          }
          const err = new Error(errorMessage);
          err.status = response.status;
          throw err;
        }

        return await response.json();
      } catch (err) {
        lastError = err;
        const msg = String(err.message || '').toLowerCase();

        // Immediate Fast-Fail on Auth & Session errors (0-delay abort)
        const isAuthError =
          msg.includes('expired') ||
          msg.includes('session') ||
          msg.includes('unauthorized') ||
          msg.includes('forbidden') ||
          msg.includes('cannot perform operation') ||
          err.status === 401 ||
          err.status === 403 ||
          err.status === 400 ||
          err.status === 404 ||
          isProbe;

        if (isAuthError) {
          throw err; // Stop immediately, do not retry
        }

        if (attempt < maxAttempts) {
          const delay = backoffs[attempt - 1] || 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        break;
      }
    }

    throw lastError;
  }

  /**
   * Validates Mews Connector API credentials against official Mews servers.
   * Auto-detects whether the token belongs to Production (api.mews.com) or Demo (api.mews-demo.com).
   * Dynamically extracts Enterprise Name, Property ID, and establishes verified real connection.
   */
  async validateEnterpriseAccess(tokenOrPropertyId) {
    const cleanToken = (tokenOrPropertyId && String(tokenOrPropertyId).trim()) || '';
    if (!cleanToken || cleanToken.length < 4) {
      throw new Error('Valid Mews Access Token is required');
    }

    let enterpriseId = '';
    let enterpriseName = '';
    let raw = null;
    let verifiedBaseUrl = null;
    let lastAuthError = null;

    // Iterate across candidate Mews environments (Configured -> Production -> Demo)
    for (const candidateUrl of this.candidateUrls) {
      try {
        // 1. Try to fetch enterprise configuration (Probe mode)
        const configData = await this._post('/configuration/get', cleanToken, {}, {
          overrideBaseUrl: candidateUrl,
          isProbe: true,
        });
        if (configData?.Enterprise) {
          enterpriseId = configData.Enterprise.Id || '';
          enterpriseName = configData.Enterprise.Name || configData.Enterprise.LegalName || '';
          raw = configData;
          verifiedBaseUrl = candidateUrl;
          break;
        }
      } catch (err) {
        lastAuthError = err;
        // 2. Try customer probe if configuration/get is restricted
        try {
          const custData = await this._post('/customers/getAll', cleanToken, {
            Limitation: { Count: 1 },
            FirstNames: ['a', 'e', 'i', 'o', 'u'],
          }, {
            overrideBaseUrl: candidateUrl,
            isProbe: true,
          });
          if (custData && (custData.Customers || Array.isArray(custData))) {
            raw = custData;
            verifiedBaseUrl = candidateUrl;
            break;
          }
        } catch (custErr) {
          lastAuthError = custErr;
        }
      }
    }

    if (!verifiedBaseUrl) {
      const errMsg = lastAuthError?.message || 'Invalid Mews Access Token or unreachable Mews API';
      const cleanErrMsg = errMsg.replace(/^Mews API Error:\s*/i, '').replace(/^Mews API returned HTTP \d+:\s*/i, '');
      const err = new Error(`Mews authentication failed: ${cleanErrMsg}`);
      err.statusCode = lastAuthError?.status === 429 ? 429 : 400;
      err.code = 'PMS_AUTH_FAILED';
      throw err;
    }

    // Cache verified live server for this token
    this._setCached(cleanToken, { resolvedBaseUrl: verifiedBaseUrl });
    this.baseUrl = verifiedBaseUrl;

    if (!enterpriseId) {
      enterpriseId = cleanToken.length >= 8 ? cleanToken.slice(0, 8) : cleanToken;
    }
    if (!enterpriseName) {
      enterpriseName = verifiedBaseUrl.includes('demo') ? 'Mews Demo Property' : 'Mews Production Property';
    }

    const environmentType = verifiedBaseUrl.includes('demo') ? 'sandbox' : 'production';
    console.log(`[MewsClient] Connected successfully to Mews (${environmentType}) at ${verifiedBaseUrl}`);

    return {
      success: true,
      status: 'connected',
      pmsType: 'mews',
      environment: environmentType,
      propertyId: enterpriseId,
      enterpriseId,
      enterpriseName,
      accessTokenUsed: cleanToken,
      raw,
    };
  }

  /**
   * Fetch Services from Mews Connector API with In-Memory Caching
   * Endpoint: POST /api/connector/v1/services/getAll
   */
  async getServices(accessToken) {
    const cached = this._getCached(accessToken);
    if (cached?.services && cached.services.length > 0) {
      return cached.services;
    }

    try {
      const data = await this._post('/services/getAll', accessToken, {
        Limitation: { Count: 50 },
      });
      const services = data.Services || [];
      const stayService = services.find(
        (s) => s.Type === 'Stay' || s.Name?.toLowerCase().includes('stay')
      );
      this._setCached(accessToken, {
        services,
        stayServiceId: stayService?.Id || this.cachedStayServiceId || null,
      });
      return services;
    } catch (err) {
      console.warn('[MewsClient] getServices notice:', err.message);
      return [];
    }
  }

  /**
   * Dynamically discover Stay Service ID from Mews services list and cache it
   */
  async getStayServiceId(accessToken) {
    if (this.cachedStayServiceId) {
      return this.cachedStayServiceId;
    }
    const cached = this._getCached(accessToken);
    if (cached?.stayServiceId) {
      return cached.stayServiceId;
    }
    try {
      const services = await this.getServices(accessToken);
      const stayService = services.find(
        (s) => s.Type === 'Stay' || s.Name?.toLowerCase().includes('stay')
      );
      if (stayService?.Id) {
        this.cachedStayServiceId = stayService.Id;
        this._setCached(accessToken, { stayServiceId: stayService.Id });
        return stayService.Id;
      }
    } catch (err) {
      console.warn('[MewsClient] getStayServiceId notice:', err.message);
    }
    return process.env.MEWS_STAY_SERVICE_ID || null;
  }

  /**
   * Update Room/Space cleaning or condition state in Mews Connector API
   * Endpoint: POST /api/connector/v1/spaces/updateState
   */
  async updateSpaceState(accessToken, spaceId, state) {
    if (!spaceId || !state) return null;
    const mewsStateMap = {
      Clean: 'Clean',
      Dirty: 'Dirty',
      Inspected: 'Inspected',
      Maintenance: 'OutOfOrder',
      Blocked: 'OutOfService',
    };
    const mewsState = mewsStateMap[state] || state;
    try {
      // Modern Mews Connector API endpoint
      return await this._post('/resources/update', accessToken, {
        ResourceId: spaceId,
        State: mewsState,
      });
    } catch (modernErr) {
      try {
        // Fallback for legacy Mews Connector API accounts
        return await this._post('/spaces/updateState', accessToken, {
          SpaceId: spaceId,
          State: mewsState,
        });
      } catch (err) {
        console.warn('[MewsClient] updateSpaceState notice:', err.message);
        return null;
      }
    }
  }

  /**
   * Fetch Resources/Rooms from Mews Connector API
   * Endpoint: POST /api/connector/v1/resources/getAll
   */
  async getResources(accessToken, options = {}) {
    const data = await this._post('/resources/getAll', accessToken, {
      Limitation: { Count: options.limit || 100 },
      Extent: { Resources: true, ResourceCategories: true, ...(options.extent || {}) },
      ...options,
    });
    return data.Resources || [];
  }

  /**
   * Fetch Customers/Guests from Mews Connector API
   * Endpoint: POST /api/connector/v1/customers/getAll
   */
  async getCustomers(accessToken, options = {}) {
    const limit = options.limit || 100;
    const filter = {
      Limitation: { Count: limit },
      Extent: { Customers: true, Addresses: true },
    };
    if (options.customerIds && options.customerIds.length > 0) {
      filter.CustomerIds = options.customerIds;
    } else if (options.createdUtc) {
      filter.CreatedUtc = options.createdUtc;
    } else if (options.updatedUtc) {
      filter.UpdatedUtc = options.updatedUtc;
    } else {
      const now = new Date();
      const past30d = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
      filter.UpdatedUtc = {
        StartUtc: past30d,
        EndUtc: now.toISOString(),
      };
    }

    try {
      const data = await this._post('/customers/getAll', accessToken, filter);
      if (data.Customers && data.Customers.length > 0) {
        return data.Customers;
      }
    } catch (err) {
      if (String(err.message).toLowerCase().includes('expired') || String(err.message).toLowerCase().includes('session')) {
        throw err;
      }
      console.warn('[MewsClient] getCustomers notice, trying standard query:', err.message);
      try {
        const fallbackData = await this._post('/customers/getAll', accessToken, {
          Limitation: { Count: limit },
          Extent: { Customers: true, Addresses: true },
        });
        return fallbackData.Customers || [];
      } catch (fbErr) {
        console.warn('[MewsClient] getCustomers fallback failed:', fbErr.message);
        return [];
      }
    }
    return [];
  }

  /**
   * Fetch Reservations from Mews Connector API
   * Endpoint: POST /api/connector/v1/reservations/getAll
   */
  async getReservations(accessToken, options = {}) {
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
    const end = new Date(start.getTime() + 72 * 60 * 60 * 1000); // 72 hours total window

    const startUtc = start.toISOString();
    const endUtc = end.toISOString();
    const limit = options.limit || 50;

    // 1. Primary: Mews Colliding reservations
    try {
      const data = await this._post('/reservations/getAll', accessToken, {
        TimeFilter: 'Colliding',
        StartUtc: startUtc,
        EndUtc: endUtc,
        Limitation: { Count: limit },
        Extent: { Reservations: true, Customers: true },
      });
      if (data && data.Reservations && data.Reservations.length > 0) {
        return data.Reservations;
      }
    } catch (collidingErr) {
      if (String(collidingErr.message).toLowerCase().includes('expired') || String(collidingErr.message).toLowerCase().includes('session')) {
        throw collidingErr;
      }
      try {
        const data = await this._post('/reservations/getAll', accessToken, {
          CollidingUtc: { StartUtc: startUtc, EndUtc: endUtc },
          Limitation: { Count: limit },
          Extent: { Reservations: true, Customers: true },
        });
        if (data && data.Reservations && data.Reservations.length > 0) {
          return data.Reservations;
        }
      } catch (nestedErr) {
        if (String(nestedErr.message).toLowerCase().includes('expired') || String(nestedErr.message).toLowerCase().includes('session')) {
          throw nestedErr;
        }
      }
    }

    // 2. Secondary: Fallback to recent reservations via TimeFilter: "Created"
    try {
      const createdStartUtc = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const createdEndUtc = now.toISOString();
      const data = await this._post('/reservations/getAll', accessToken, {
        TimeFilter: 'Created',
        StartUtc: createdStartUtc,
        EndUtc: createdEndUtc,
        Limitation: { Count: limit },
        Extent: { Reservations: true, Customers: true },
      });
      return data.Reservations || [];
    } catch (createdErr) {
      return [];
    }
  }

  /**
   * Fetch Availability from Mews Connector API
   * Endpoint: POST /api/connector/v1/services/getAvailability
   */
  async getAvailability(accessToken, { startUtc, endUtc, serviceId } = {}) {
    try {
      let effectiveServiceId = serviceId;
      if (!effectiveServiceId) {
        effectiveServiceId = await this.getStayServiceId(accessToken);
      }
      const data = await this._post('/services/getAvailability', accessToken, {
        StartUtc: startUtc || new Date().toISOString(),
        EndUtc: endUtc || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        ...(effectiveServiceId ? { ServiceId: effectiveServiceId } : {}),
      });
      return data.ResourceCategoryAvailabilities || [];
    } catch (err) {
      console.warn('[MewsClient] getAvailability notice:', err.message);
      return [];
    }
  }

  /**
   * Fetch Rates & Pricing from Mews Connector API
   * Endpoint: POST /api/connector/v1/rates/getAll
   */
  async getRates(accessToken, options = {}) {
    try {
      const data = await this._post('/rates/getAll', accessToken, {
        Limitation: { Count: options.limit || 50 },
        Extent: { Rates: true, RateGroups: true, ...(options.extent || {}) },
        ...options,
      });
      return data.Rates || [];
    } catch (err) {
      console.warn('[MewsClient] getRates notice:', err.message);
      return [];
    }
  }

  /**
   * Update Room/Space Status in Mews Connector API
   * Endpoint: POST /api/connector/v1/spaces/update
   */
  async updateSpaceStatus(accessToken, { spaceId, status }) {
    if (!spaceId) return { success: false, reason: 'Missing spaceId' };
    try {
      const data = await this._post('/spaces/update', accessToken, {
        SpaceId: spaceId,
        State: status,
      });
      return { success: true, data };
    } catch (err) {
      console.warn('[MewsClient] updateSpaceStatus notice:', err.message);
      return { success: false, error: err.message };
    }
  }
}
