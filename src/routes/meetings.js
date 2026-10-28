// Workspace meetings: Google Meet, Zoom, Microsoft Teams, and custom conference links.
// Anyone in the workspace can view and join workspace meetings or schedule upcoming meetings.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { avatarUrlOf } from "../services/avatars.js";
import { publish } from "../services/realtime.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

export const PLATFORMS = ["google_meet", "zoom", "teams", "custom"];

export function detectPlatform(url) {
  if (!url) return "custom";
  const lower = url.toLowerCase();
  if (lower.includes("meet.google.com")) return "google_meet";
  if (lower.includes("zoom.us")) return "zoom";
  if (lower.includes("teams.microsoft.com") || lower.includes("teams.live.com")) return "teams";
  return "custom";
}

export function platformLabel(platform) {
  switch (platform) {
    case "google_meet":
      return "Google Meet";
    case "zoom":
      return "Zoom";
    case "teams":
      return "Microsoft Teams";
    default:
      return "Video Call";
  }
}

const safeMeetingUrl = z
  .string()
  .trim()
  .min(5, "Meeting URL is required.")
  .max(1000, "URL is too long.")
  .refine(
    val => /^https?:\/\/[^\s"'()<>\\]+$/i.test(val),
    "Meeting link must start with https:// or http:// and cannot contain spaces, quotes, or brackets."
  );

const createSchema = z.object({
  title: z.string().trim().min(1, "Meeting title is required.").max(200, "Keep title under 200 characters."),
  description: z.string().trim().max(5000, "Description is too long.").optional().nullable(),
  platform: z.enum(PLATFORMS).optional(),
  url: safeMeetingUrl,
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }).optional().nullable(),
  reminderMinutes: z.coerce.number().int().min(1).max(120).default(5),
  participantIds: z.array(z.number().int().positive()).optional().default([]),
  isInstant: z.boolean().optional().default(false),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).nullable(),
    platform: z.enum(PLATFORMS),
    url: safeMeetingUrl,
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }).nullable(),
    reminderMinutes: z.coerce.number().int().min(1).max(120),
    participantIds: z.array(z.number().int().positive()),
  })
  .partial();

const querySchema = z.object({
  scope: z.enum(["upcoming", "today", "past", "all"]).default("upcoming"),
  search: z.string().trim().max(200).optional(),
});

function canManageMeeting(req, meeting) {
  if (meeting.created_by === req.user.id) return true;
  if (req.user.isOwner) return true;
  return Boolean(req.user.permissions?.includes("workspace.users.manage"));
}

router.get("/", async (req, res) => {
  const q = validate(querySchema, req.query);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const now = nowIso();
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60_000).toISOString();

  let query = db("meetings as m")
    .leftJoin("users as u", "u.id", "m.created_by")
    .where("m.tenant_id", tenantId)
    .select(
      "m.*",
      "u.name as creator_name",
      "u.email as creator_email",
      "u.preferences as creator_preferences"
    );

  // Scope filtering
  if (q.scope === "upcoming") {
    query = query.where("m.start_at", ">=", thirtyMinutesAgo).orderBy("m.start_at", "asc");
  } else if (q.scope === "today") {
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const todayEnd = new Date(new Date().setHours(23, 59, 59, 999)).toISOString();
    query = query.whereBetween("m.start_at", [todayStart, todayEnd]).orderBy("m.start_at", "asc");
  } else if (q.scope === "past") {
    query = query.where("m.start_at", "<", thirtyMinutesAgo).orderBy("m.start_at", "desc");
  } else {
    query = query.orderBy("m.start_at", "desc");
  }

  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    query = query.where(inner => {
      inner.whereRaw("lower(m.title) like ?", [term]).orWhereRaw("lower(m.url) like ?", [term]);
    });
  }

  const rows = await query.limit(100);

  // Fetch participants for returned meetings in a single query
  const meetingIds = rows.map(r => r.id);
  const participantsByMeeting = new Map();

  if (meetingIds.length > 0) {
    const participants = await db("meeting_participants as mp")
      .join("users as u", "u.id", "mp.user_id")
      .whereIn("mp.meeting_id", meetingIds)
      .select("mp.meeting_id", "u.id", "u.name", "u.email", "u.preferences");

    for (const p of participants) {
      if (!participantsByMeeting.has(p.meeting_id)) {
        participantsByMeeting.set(p.meeting_id, []);
      }
      participantsByMeeting.get(p.meeting_id).push({
        id: p.id,
        name: p.name,
        email: p.email,
        avatarUrl: avatarUrlOf(p, req),
      });
    }
  }

  const items = rows.map(row => {
    const participants = participantsByMeeting.get(row.id) ?? [];
    // User is included if meeting is workspace-wide (empty participants) or user is in participant list or is creator
    const isParticipant = participants.length === 0 || participants.some(p => p.id === req.user.id) || row.created_by === req.user.id;

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      platform: row.platform,
      platformLabel: platformLabel(row.platform),
      url: row.url,
      startAt: row.start_at,
      endAt: row.end_at,
      reminderMinutes: row.reminder_minutes,
      reminderSent: Boolean(row.reminder_sent),
      isInstant: Boolean(row.is_instant),
      createdBy: row.created_by
        ? {
            id: row.created_by,
            name: row.creator_name,
            email: row.creator_email,
            avatarUrl: avatarUrlOf({ email: row.creator_email, preferences: row.creator_preferences }, req),
          }
        : null,
      participants,
      isParticipant,
      canManage: canManageMeeting(req, row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  res.json({ items });
});

router.get("/:id", async (req, res) => {
  const db = getDb();
  const id = parseId(req.params.id);
  const tenantId = req.user.tenant_id;

  const row = await db("meetings as m")
    .leftJoin("users as u", "u.id", "m.created_by")
    .where({ "m.id": id, "m.tenant_id": tenantId })
    .select(
      "m.*",
      "u.name as creator_name",
      "u.email as creator_email",
      "u.preferences as creator_preferences"
    )
    .first();

  if (!row) throw new HttpError(404, "Meeting not found.");

  const participants = await db("meeting_participants as mp")
    .join("users as u", "u.id", "mp.user_id")
    .where("mp.meeting_id", id)
    .select("u.id", "u.name", "u.email", "u.preferences");

  res.json({
    id: row.id,
    title: row.title,
    description: row.description,
    platform: row.platform,
    platformLabel: platformLabel(row.platform),
    url: row.url,
    startAt: row.start_at,
    endAt: row.end_at,
    reminderMinutes: row.reminder_minutes,
    reminderSent: Boolean(row.reminder_sent),
    isInstant: Boolean(row.is_instant),
    createdBy: row.created_by
      ? {
          id: row.created_by,
          name: row.creator_name,
          email: row.creator_email,
          avatarUrl: avatarUrlOf({ email: row.creator_email, preferences: row.creator_preferences }, req),
        }
      : null,
    participants: participants.map(p => ({
      id: p.id,
      name: p.name,
      email: p.email,
      avatarUrl: avatarUrlOf(p, req),
    })),
    canManage: canManageMeeting(req, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

router.post("/", async (req, res) => {
  const input = validate(createSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const platform = input.platform || detectPlatform(input.url);
  const now = nowIso();

  const id = await db.transaction(async trx => {
    const meetingId = await insertAndGetId(trx, "meetings", {
      tenant_id: tenantId,
      created_by: req.user.id,
      title: input.title,
      description: input.description ?? null,
      platform,
      url: input.url,
      start_at: new Date(input.startAt).toISOString(),
      end_at: input.endAt ? new Date(input.endAt).toISOString() : null,
      reminder_minutes: input.reminderMinutes,
      reminder_sent: false,
      is_instant: input.isInstant,
      created_at: now,
      updated_at: now,
    });

    if (input.participantIds && input.participantIds.length > 0) {
      const validUsers = await trx("users")
        .where("tenant_id", tenantId)
        .whereIn("id", input.participantIds)
        .select("id");

      const links = validUsers.map(u => ({
        meeting_id: meetingId,
        user_id: u.id,
        created_at: now,
      }));

      if (links.length > 0) {
        await trx("meeting_participants").insert(links);
      }
    }

    return meetingId;
  });

  // Notify workspace / participants via realtime WebSocket
  publish(
    { tenantId },
    "meeting.created",
    {
      meetingId: id,
      title: input.title,
      platform,
      url: input.url,
      startAt: new Date(input.startAt).toISOString(),
      creatorName: req.user.name,
    }
  );

  const row = await db("meetings as m")
    .leftJoin("users as u", "u.id", "m.created_by")
    .where({ "m.id": id })
    .select("m.*", "u.name as creator_name", "u.email as creator_email")
    .first();

  res.status(201).json({
    id: row.id,
    title: row.title,
    description: row.description,
    platform: row.platform,
    platformLabel: platformLabel(row.platform),
    url: row.url,
    startAt: row.start_at,
    endAt: row.end_at,
    reminderMinutes: row.reminder_minutes,
    reminderSent: Boolean(row.reminder_sent),
    isInstant: Boolean(row.is_instant),
    createdBy: { id: req.user.id, name: req.user.name },
    participants: [],
    canManage: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

router.patch("/:id", async (req, res) => {
  const db = getDb();
  const id = parseId(req.params.id);
  const tenantId = req.user.tenant_id;
  const current = await db("meetings").where({ id, tenant_id: tenantId }).first();

  if (!current) throw new HttpError(404, "Meeting not found.");
  if (!canManageMeeting(req, current)) {
    throw new HttpError(403, "Only the meeting organizer or workspace admin can edit this meeting.");
  }

  const input = validate(updateSchema, req.body ?? {});
  const now = nowIso();
  const changes = { updated_at: now };

  if (input.title !== undefined) changes.title = input.title;
  if (input.description !== undefined) changes.description = input.description;
  if (input.url !== undefined) {
    changes.url = input.url;
    changes.platform = input.platform ?? detectPlatform(input.url);
  } else if (input.platform !== undefined) {
    changes.platform = input.platform;
  }
  if (input.startAt !== undefined) {
    changes.start_at = new Date(input.startAt).toISOString();
    // If rescheduled into future, reset reminder_sent so participants get alerted again
    if (new Date(input.startAt).getTime() > Date.now()) {
      changes.reminder_sent = false;
    }
  }
  if (input.endAt !== undefined) {
    changes.end_at = input.endAt ? new Date(input.endAt).toISOString() : null;
  }
  if (input.reminderMinutes !== undefined) {
    changes.reminder_minutes = input.reminderMinutes;
  }

  await db.transaction(async trx => {
    await trx("meetings").where({ id }).update(changes);

    if (input.participantIds !== undefined) {
      await trx("meeting_participants").where({ meeting_id: id }).delete();
      if (input.participantIds.length > 0) {
        const validUsers = await trx("users")
          .where("tenant_id", tenantId)
          .whereIn("id", input.participantIds)
          .select("id");

        const links = validUsers.map(u => ({
          meeting_id: id,
          user_id: u.id,
          created_at: now,
        }));
        if (links.length > 0) {
          await trx("meeting_participants").insert(links);
        }
      }
    }
  });

  publish({ tenantId }, "meeting.updated", {
    meetingId: id,
    title: changes.title ?? current.title,
    url: changes.url ?? current.url,
    platform: changes.platform ?? current.platform,
    startAt: changes.start_at ?? current.start_at,
  });

  res.json({ ok: true, id });
});

router.delete("/:id", async (req, res) => {
  const db = getDb();
  const id = parseId(req.params.id);
  const tenantId = req.user.tenant_id;
  const current = await db("meetings").where({ id, tenant_id: tenantId }).first();

  if (!current) throw new HttpError(404, "Meeting not found.");
  if (!canManageMeeting(req, current)) {
    throw new HttpError(403, "Only the meeting organizer or workspace admin can delete this meeting.");
  }

  await db("meetings").where({ id }).delete();

  publish({ tenantId }, "meeting.deleted", { meetingId: id });
  res.status(204).end();
});

export default router;
