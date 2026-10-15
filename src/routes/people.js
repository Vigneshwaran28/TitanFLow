// People directory: everyone in the signed-in user's workspace, with their teams. Also feeds assignee and member pickers.
import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { avatarUrlOf } from "../services/avatars.js";
import { upcomingCelebrations } from "../services/celebrations.js";
import { rolesByUser, usersWithPermission } from "../services/permissions.js";
import { validate } from "../utils/http.js";

const router = Router();

const querySchema = z.object({
  search: z.string().trim().max(100).optional(),
  teamId: z.coerce.number().int().positive().optional(),
  role: z.enum(["owner", "admin", "agent", "member", "staff"]).optional(),
  roleId: z.coerce.number().int().positive().optional(),
  includeInactive: z.enum(["true"]).optional(),
});

router.get("/", async (req, res) => {
  const q = validate(querySchema, req.query);
  const db = getDb();

  const tenantId = req.user.tenant_id;
  const query = db("users").where("tenant_id", tenantId).select("id", "name", "email", "job_title", "is_active", "date_of_birth", "show_birthday", "joined_on", "created_at", "preferences").orderByRaw("lower(name)");
  if (!q.includeInactive) query.where("is_active", true);
  // "staff" = people who work the help desk; other values are built-in role keys.
  if (q.role === "staff") query.whereIn("id", await usersWithPermission(db, tenantId, "helpdesk.work"));
  else if (q.role) query.whereIn("id", db("user_roles as ur").join("roles as r", "r.id", "ur.role_id").where({ "r.tenant_id": tenantId, "r.key": q.role }).select("ur.user_id"));
  if (q.roleId) query.whereIn("id", db("user_roles").where("role_id", q.roleId).select("user_id"));
  if (q.teamId) query.whereIn("id", db("team_members").select("user_id").where("team_id", q.teamId));
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    query.where(inner =>
      inner.whereRaw("lower(name) like ?", [term]).orWhereRaw("lower(email) like ?", [term]).orWhereRaw("lower(coalesce(job_title, '')) like ?", [term])
    );
  }

  const [users, memberships, roles] = await Promise.all([
    query,
    db("team_members as m").join("teams as t", "t.id", "m.team_id").where("t.tenant_id", tenantId).select("m.user_id", "m.is_lead", "t.id", "t.name", "t.color").orderByRaw("lower(t.name)"),
    rolesByUser(db, tenantId),
  ]);

  res.json(
    users.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      roles: (roles.get(user.id) ?? []).map(role => ({ id: role.id, key: role.key, name: role.name })),
      jobTitle: user.job_title,
      avatarUrl: avatarUrlOf(user.preferences),
      isActive: Boolean(user.is_active),
      // Day and month only, and only when the person shares it.
      birthday: user.show_birthday && user.date_of_birth ? user.date_of_birth.slice(5) : null,
      joinedOn: user.joined_on ?? null,
      createdAt: user.created_at,
      teams: memberships
        .filter(row => row.user_id === user.id)
        .map(row => ({ id: row.id, name: row.name, color: row.color, isLead: Boolean(row.is_lead) })),
    }))
  );
});

/** Birthdays and work anniversaries coming up in the workspace (for the home page). */
router.get("/celebrations", async (req, res) => {
  const { days } = validate(z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }), req.query);
  res.json(await upcomingCelebrations(getDb(), req.user.tenant_id, req.tenant.settings, { days }));
});

export default router;
