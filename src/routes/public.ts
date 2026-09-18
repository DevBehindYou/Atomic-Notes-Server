import { Hono } from 'hono';
import { getDb } from '../db/mongo.js';
import { collections } from '../db/collections.js';

const publicRoute = new Hono();

/**
 * Unauthenticated on purpose — this is public marketing-site content, the
 * same trust level as the rest of Community's static pages. Returns every
 * active, unexpired notification; Community's own pages already do their
 * own limit(3)/priority-sort in JS (see page.tsx / updates/page.tsx) — kept
 * there rather than duplicated here, so this endpoint stays one shape shared
 * by both callers.
 */
publicRoute.get('/notifications/active', async (c) => {
  const db = await getDb();
  const now = new Date();
  const rows = await collections
    .notifications(db)
    .find({ status: 'active', targetAudience: 'all', targetUserId: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] })
    .sort({ createdAt: -1 })
    .toArray();

  return c.json({
    rows: rows.map((n) => ({
      id: n._id,
      type: n.type,
      subject: n.subject,
      description: n.description,
      priority: n.priority,
      status: n.status,
      action: n.action,
      action_url: n.actionUrl,
      icon: n.icon,
      target_audience: n.targetAudience,
      min_app_version: n.minAppVersion,
      max_app_version: n.maxAppVersion,
      created_at: n.createdAt.toISOString(),
      expires_at: n.expiresAt ? n.expiresAt.toISOString() : null,
    })),
  });
});

export default publicRoute;
