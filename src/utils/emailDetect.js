import { resolveMx, resolveSrv, resolve4 } from 'node:dns/promises';

const ssl = (imapHost, smtpHost) => ({
  imapHost,
  imapPort: 993,
  imapSecurity: 'SSL/TLS',
  smtpHost,
  smtpPort: 465,
  smtpSecurity: 'SSL/TLS',
});

const PROVIDERS = [
  {
    key: 'google',
    name: 'Google Workspace',
    method: 'oauth',
    mxMatches: ['aspmx.l.google.com', 'googlemail.com', 'google.com', 'psmtp.com'],
    note: 'Sign in with Google — no password is stored.',
  },
  {
    key: 'microsoft',
    name: 'Microsoft 365',
    method: 'oauth',
    mxMatches: ['mail.protection.outlook.com', 'protection.outlook.com', 'outlook.com', 'office365.com'],
    note: 'Sign in with Microsoft — no password is stored.',
  },
  {
    key: 'hostinger',
    name: 'Hostinger Email',
    method: 'credentials',
    mxMatches: ['hostinger', 'titan.email'],
    settings: () => ssl('imap.titan.email', 'smtp.titan.email'),
    note: 'Hostinger mailboxes run on Titan. Use your mailbox password or an app password.',
  },
  {
    key: 'zoho',
    name: 'Zoho Mail',
    method: 'credentials',
    mxMatches: ['zoho.com', 'zoho.eu', 'zohomail'],
    settings: (domain) => (domain.endsWith('.eu') ? ssl('imap.zoho.eu', 'smtp.zoho.eu') : ssl('imap.zoho.com', 'smtp.zoho.com')),
    note: 'Zoho requires an application-specific password when two-factor is on.',
  },
  {
    key: 'fastmail',
    name: 'Fastmail',
    method: 'credentials',
    mxMatches: ['messagingengine.com', 'fastmail'],
    settings: () => ssl('imap.fastmail.com', 'smtp.fastmail.com'),
    note: 'Fastmail requires an app password for IMAP and SMTP.',
  },
  {
    key: 'proton',
    name: 'Proton Mail',
    method: 'credentials',
    mxMatches: ['protonmail.ch', 'proton.me', 'protonmail.com'],
    settings: () => ({
      imapHost: '127.0.0.1',
      imapPort: 1143,
      imapSecurity: 'STARTTLS (Proton Bridge)',
      smtpHost: '127.0.0.1',
      smtpPort: 1025,
      smtpSecurity: 'STARTTLS (Proton Bridge)',
    }),
    note: 'Proton needs Proton Bridge for IMAP access.',
  },
  {
    key: 'ionos',
    name: 'IONOS',
    method: 'credentials',
    mxMatches: ['ionos', '1and1', 'kundenserver', 'perfora'],
    settings: () => ssl('imap.ionos.com', 'smtp.ionos.com'),
  },
  {
    key: 'ovh',
    name: 'OVH',
    method: 'credentials',
    mxMatches: ['ovh.net', 'ovh.com'],
    settings: () => ssl('ssl0.ovh.net', 'ssl0.ovh.net'),
  },
  {
    key: 'godaddy',
    name: 'GoDaddy / Secureserver',
    method: 'credentials',
    mxMatches: ['secureserver.net', 'godaddy'],
    settings: () => ssl('imap.secureserver.net', 'smtpout.secureserver.net'),
  },
];

const TIMEOUT_MS = 2500;

async function withTimeout(work, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), TIMEOUT_MS);
  });
  try {
    return await Promise.race([work.catch(() => fallback), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveMxDoH(domain) {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const urls = [
      `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { accept: 'application/dns-json' },
          signal: controller.signal,
        });
        if (!res.ok) continue;
        const data = await res.json();
        if (data && Array.isArray(data.Answer)) {
          const mxAnswers = data.Answer.filter((a) => a.type === 15 && typeof a.data === 'string');
          if (mxAnswers.length > 0) {
            return mxAnswers.map((a) => {
              const parts = a.data.trim().split(/\s+/);
              const priority = parts.length >= 2 ? Number(parts[0]) || 10 : 10;
              const exchange = (parts.length >= 2 ? parts.slice(1).join(' ') : parts[0]).replace(/\.$/, '');
              return { priority, exchange };
            });
          }
        }
      } catch (_) {
        // Continue to fallback DoH provider
      }
    }
    return [];
  } catch (_) {
    return [];
  } finally {
    clearTimeout(abort);
  }
}

async function resolveMxSafe(domain) {
  // 1. Primary: Native Node.js DNS resolver
  let records = await withTimeout(resolveMx(domain), []);
  // 2. Fallback: Standard DNS-over-HTTPS (DoH) if native DNS query was refused or empty
  if (!records || records.length === 0) {
    records = await resolveMxDoH(domain);
  }
  return records || [];
}

function normaliseDomain(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim().toLowerCase();
  const domain = raw.includes('@') ? raw.slice(raw.lastIndexOf('@') + 1) : raw;
  const cleaned = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(cleaned)) return null;
  return cleaned;
}

function matchProvider(mx, domain) {
  const haystack = mx.join(' ');
  for (const provider of PROVIDERS) {
    if (provider.mxMatches.some((m) => haystack.includes(m))) {
      return {
        key: provider.key,
        name: provider.name,
        method: provider.method,
        settings: provider.settings ? provider.settings(domain) : null,
        note: provider.note || null,
      };
    }
  }
  return null;
}

async function autodiscover(domain) {
  const srvAutodiscover = await withTimeout(resolveSrv(`_autodiscover._tcp.${domain}`), []);
  const srvImap = await withTimeout(resolveSrv(`_imaps._tcp.${domain}`), []);
  const srvSubmission = await withTimeout(
    resolveSrv(`_submission._tcp.${domain}`).catch(() => resolveSrv(`_submissions._tcp.${domain}`)),
    []
  );

  let https = false;
  try {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(`https://autodiscover.${domain}/autodiscover/autodiscover.xml`, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(abort);
    https = response.status !== 404;
  } catch {
    https = false;
  }

  const guesses = await Promise.all(
    ['imap', 'mail', 'smtp'].map(async (prefix) => {
      const host = `${prefix}.${domain}`;
      const addresses = await withTimeout(resolve4(host), []);
      return addresses.length ? host : null;
    })
  );

  const imapHost = srvImap[0]?.name || guesses[0] || guesses[1];
  const smtpHost = srvSubmission[0]?.name || guesses[2] || guesses[1];

  const found = Boolean(srvAutodiscover.length || https || imapHost || smtpHost);

  return {
    tried: true,
    srv: srvAutodiscover.length > 0,
    https,
    found,
    microsoftLikely: srvAutodiscover.some((r) => r.name?.toLowerCase().includes('outlook.com')) || srvAutodiscover.length > 0,
    settings:
      imapHost && smtpHost
        ? {
            imapHost,
            imapPort: srvImap[0]?.port || 993,
            imapSecurity: 'SSL/TLS',
            smtpHost,
            smtpPort: srvSubmission[0]?.port || 587,
            smtpSecurity: srvSubmission[0]?.port === 465 ? 'SSL/TLS' : 'STARTTLS',
          }
        : null,
  };
}

export async function detectEmailProvider(input) {
  const domain = normaliseDomain(input);
  if (!domain) {
    return {
      error: 'Provide a valid email or domain',
      provider: 'unknown',
      method: 'manual',
    };
  }

  const records = await resolveMxSafe(domain);
  const mx = records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase().replace(/\.$/, ''));

  const known = matchProvider(mx, domain);

  if (known) {
    return {
      domain,
      provider: known.key,
      providerName: known.name,
      method: known.method,
      mx,
      checks: { incoming: true, outgoing: true, security: true },
      settings: known.settings,
      autodiscover: null,
      note: known.note,
      source: 'mx',
    };
  }

  const discovery = await autodiscover(domain);

  if (discovery.found && discovery.microsoftLikely && !mx.length) {
    return {
      domain,
      provider: 'microsoft',
      providerName: 'Microsoft 365',
      method: 'oauth',
      mx,
      checks: { incoming: true, outgoing: true, security: true },
      settings: null,
      autodiscover: { srv: discovery.srv, https: discovery.https },
      note: 'Found through Autodiscover rather than MX.',
      source: 'autodiscover',
    };
  }

  if (discovery.settings) {
    return {
      domain,
      provider: 'autodiscovered',
      providerName: mx.length ? `Mail host at ${mx[0]}` : `Mail host for ${domain}`,
      method: 'credentials',
      mx,
      checks: {
        incoming: Boolean(discovery.settings.imapHost),
        outgoing: Boolean(discovery.settings.smtpHost),
        security: true,
      },
      settings: discovery.settings,
      autodiscover: { srv: discovery.srv, https: discovery.https },
      note: 'Settings found by autodiscovery. Confirm them before connecting.',
      source: 'autodiscover',
    };
  }

  return {
    domain,
    provider: 'unknown',
    providerName: 'Unknown provider',
    method: 'manual',
    mx,
    checks: { incoming: false, outgoing: false, security: false },
    settings: null,
    autodiscover: { srv: discovery.srv, https: discovery.https },
    note: mx.length
      ? `Your domain receives mail at ${mx[0]}, but we do not recognise it.`
      : 'No mail servers found for this domain.',
    source: 'none',
  };
}
