'use strict';

const fetch = global.fetch || require('node-fetch');
const jwt   = require('jsonwebtoken');

const SUPABASE_REST_URL         = process.env.SUPABASE_REST_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COOKIE_NAME               = process.env.SESSION_COOKIE_NAME || 'pc_session';
const JWT_SECRET                = process.env.JWT_SECRET || 'dev_only_change_me';
const ADMIN_IDS = new Set((process.env.PC_ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));

function readSession(req) {
  try {
    const t = req.cookies?.[COOKIE_NAME] || (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE_NAME+'='))?.split('=')[1];
    if (!t) return null;
    return jwt.verify(t, JWT_SECRET);
  } catch { return null; }
}
function requireAuth(req, res, next) {
  const s = readSession(req);
  if (!s || !s.id) return res.status(401).json({ error: 'no_session' });
  req.user = s; next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    const s = readSession(req);
    if (!s || !s.id) return res.status(401).json({ error: 'no_session' });
    const role = s.role || s.type;
    if (!(roles.includes(role) || ADMIN_IDS.has(s.id)))
      return res.status(403).json({ error: 'forbidden' });
    req.user = s; next();
  };
}

async function sbRest(path, init = {}) {
  const base = SUPABASE_REST_URL.replace(/\/+$/,'');
  const url  = `${base}/${path.replace(/^\/+/, '')}`;
  const headers = Object.assign({
    apikey:        SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type':'application/json',
    Prefer:        'return=representation'
  }, init.headers || {});
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    const err = new Error(`Supabase REST ${res.status}: ${txt}`);
    err.status = res.status; err.body = txt;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

const nowIso = () => new Date().toISOString();
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = (app) => {
  console.log('NEWS: mounting /admin/news-events, /news-events, /news-events/unread-count, /news-events/:id/read, /news-events/go/:id');

  // Admin: create news event
  app.post('/admin/news-events', requireRole('admin','superadmin'), async (req, res) => {
    try {
      const { title, url, summary, published_at, is_published } = req.body || {};
      if (!title || !url) return res.status(400).json({ error: 'missing_fields', need: ['title','url'] });

      const when = published_at ? new Date(published_at) : new Date();
      if (isNaN(when.getTime())) return res.status(400).json({ error: 'bad_published_at' });

      let slug = slugify(title);
      if (!slug) slug = `event-${Date.now()}`;

      const payload = [{
        title,
        slug,
        summary: summary || null,
        url,
        is_published: is_published !== false,
        published_at: when.toISOString(),
        created_by: req.user.id,
        created_at: nowIso()
      }];

      let rows;
      try {
        rows = await sbRest('news_events', { method:'POST', body: JSON.stringify(payload) });
      } catch (e) {
        if (e.status === 409 || String(e.body||'').includes('duplicate')) {
          slug = `${slug}-${Math.random().toString(36).slice(2,6)}`;
          payload[0].slug = slug;
          rows = await sbRest('news_events', { method:'POST', body: JSON.stringify(payload) });
        } else { throw e; }
      }

      return res.json({ ok: true, event: rows[0] });
    } catch (e) {
      return res.status(500).json({ error: 'create_failed', detail: String(e.message||e) });
    }
  });

  // Admin: list news
  app.get('/admin/news-events', requireRole('admin','superadmin'), async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 500);
      const rows = await sbRest(`news_events?select=*&order=published_at.desc&limit=${limit}`);
      return res.json({ ok: true, events: rows });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', detail: String(e.message||e) });
    }
  });

  // Player: list published news with read flag
  app.get('/news-events', requireAuth, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 200);
      const now = encodeURIComponent(new Date().toISOString());
      const events = await sbRest(
        `news_events?is_published=eq.true&published_at=lte.${now}&select=id,title,slug,summary,url,published_at&order=published_at.desc&limit=${limit}`
      );

      // fetch reads for current user and map
      const reads = await sbRest(`news_reads?user_id=eq.${encodeURIComponent(req.user.id)}&select=event_id,read_at`);
      const readIds = new Set((reads || []).map(r => r.event_id));
      const enriched = (events || []).map(ev => ({ ...ev, is_read: readIds.has(ev.id) }));

      return res.json({ ok: true, events: enriched });
    } catch (e) {
      return res.status(500).json({ error: 'list_failed', detail: String(e.message||e) });
    }
  });

  // Player: unread count (for red bell)
  app.get('/news-events/unread-count', requireAuth, async (req, res) => {
    try {
      const now = encodeURIComponent(new Date().toISOString());
      const events = await sbRest(
        `news_events?is_published=eq.true&published_at=lte.${now}&select=id&order=published_at.desc&limit=200`
      );
      const ids = new Set((events || []).map(e => e.id));
      if (ids.size === 0) return res.json({ ok: true, unread: 0 });

      const reads = await sbRest(`news_reads?user_id=eq.${encodeURIComponent(req.user.id)}&select=event_id&limit=500`);
      for (const r of (reads || [])) ids.delete(r.event_id);
      return res.json({ ok: true, unread: ids.size });
    } catch (e) {
      return res.status(500).json({ error: 'count_failed', detail: String(e.message||e) });
    }
  });

  // Player: mark event as read
  app.post('/news-events/:id/read', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id' });
      await sbRest('news_reads', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify([{ event_id: id, user_id: req.user.id }])
      });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'mark_failed', detail: String(e.message||e) });
    }
  });

  // Player: mark read and redirect to the event URL (optional helper endpoint)
  app.get('/news-events/go/:id', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).send('bad_id');

      const rows = await sbRest(`news_events?id=eq.${id}&select=id,url,is_published,published_at&limit=1`);
      const ev = rows?.[0];
      if (!ev) return res.status(404).send('not_found');

      const published = ev.is_published && new Date(ev.published_at).getTime() <= Date.now();
      if (!published) return res.status(403).send('unpublished');

      // best-effort mark read
      await sbRest('news_reads', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify([{ event_id: id, user_id: req.user.id }])
      }).catch(()=>{});

      res.redirect(ev.url);
    } catch (e) {
      res.status(500).send('error');
    }
  });
};
