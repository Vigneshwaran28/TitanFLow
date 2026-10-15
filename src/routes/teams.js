// Teams (departments): anyone with access can see them; people with "Manage teams" create, edit, and staff them.
import { Router } from "express";
import { z } from "zod";
import { getDb, insertAndGetId } from "../db/connection.js";
import { requirePermission } from "../middleware/auth.js";
import { HttpError, nowIso, parseId, validate } from "../utils/http.js";

const router = Router();

const COLORS = ["slate", "red", "orange", "amber", "emerald", "teal", "sky", "indigo", "violet", "pink"];

const teamSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(80, "Keep the name under 80 characters."),
  description: z.string().trim().max(300, "Keep the description under 300 characters.").nullable().default(null),
  color: z.enum(COLORS).default("indigo"),
  members: z
    .array(z.object({ userId: z.number().int().positive(), isLead: z.boolean().default(false) }))
    .max(500)
    .default([]),
});

const ACTIVE_STATUSES = ["open", "in_progress", "waiting"];

/** All of a tenant's teams with members and active ticket counts, in name order. */
export async function listTeams(db, tenantId) {
  const [teams, members, ticketCounts] = await Promise.all([
    db("teams").where("tenant_id", tenantId).orderByRaw("lower(name)"),
    db("team_members as m")
      .join("users as u", "u.id", "m.user_id")
      .where("u.tenant_id", tenantId)
      .where("u.is_active", true)
      .select("m.team_id", "m.is_lead", "u.id", "u.name", "u.email", "u.job_title")
      .orderBy("m.is_lead", "desc")
      .orderByRaw("lower(u.name)"),
    db("tickets").where("tenant_id", tenantId).select("team_id").count({ count: "*" }).whereIn("status", ACTIVE_STATUSES).whereNotNull("team_id").groupBy("team_id"),
  ]);
  const openByTeam = new Map(ticketCounts.map(row => [Number(row.team_id), Number(row.count)]));

  return teams.map(team => ({
    id: team.id,
    name: team.name,
    description: team.description,
    color: team.color,
    createdAt: team.created_at,
    openTickets: openByTeam.get(team.id) ?? 0,
    members: members
      .filter(member => member.team_id === team.id)
      .map(member => ({
        id: member.id,
        name: member.name,
        email: member.email,
        jobTitle: member.job_title,
        isLead: Boolean(member.is_lead),
      })),
  }));
}

async function findTeam(db, tenantId, id) {
  const team = (await listTeams(db, tenantId)).find(item => item.id === id);
  if (!team) throw new HttpError(404, "Team not found.");
  return team;
}

async function assertUniqueName(db, tenantId, name, exceptId) {
  const query = db("teams").where("tenant_id", tenantId).whereRaw("lower(name) = ?", [name.toLowerCase()]);
  if (exceptId) query.whereNot("id", exceptId);
  if (await query.first()) {
    throw new HttpError(422, "Please fix the highlighted fields.", { errors: { name: "A team with this name already exists." } });
  }
}

async function replaceMembers(trx, tenantId, teamId, members) {
  const ids = [...new Set(members.map(member => member.userId))];
  if (ids.length) {
    const found = await trx("users").where("tenant_id", tenantId).whereIn("id", ids).count({ count: "*" });
    if (Number(found[0].count) !== ids.length) {
      throw new HttpError(422, "Please fix the highlighted fields.", { errors: { members: "One of the selected people no longer exists." } });
    }
  }
  await trx("team_members").where({ team_id: teamId }).delete();
  if (!ids.length) return;
  const createdAt = nowIso();
  const leads = new Set(members.filter(member => member.isLead).map(member => member.userId));
  await trx("team_members").insert(ids.map(userId => ({ team_id: teamId, user_id: userId, is_lead: leads.has(userId), created_at: createdAt })));
}

router.get("/", async (req, res) => {
  res.json(await listTeams(getDb(), req.user.tenant_id));
});

router.post("/", requirePermission("directory.teams.manage"), async (req, res) => {
  const input = validate(teamSchema, req.body);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  await assertUniqueName(db, tenantId, input.name);

  const id = await db.transaction(async trx => {
    const teamId = await insertAndGetId(trx, "teams", {
      tenant_id: tenantId,
      name: input.name,
      description: input.description || null,
      color: input.color,
      created_at: nowIso(),
    });
    await replaceMembers(trx, tenantId, teamId, input.members);
    return teamId;
  });
  res.status(201).json(await findTeam(db, tenantId, id));
});

router.patch("/:id", requirePermission("directory.teams.manage"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  const tenantId = req.user.tenant_id;
  const current = await findTeam(db, tenantId, id);
  const input = validate(teamSchema, {
    name: current.name,
    description: current.description,
    color: current.color,
    members: current.members.map(member => ({ userId: member.id, isLead: member.isLead })),
    ...req.body,
  });
  await assertUniqueName(db, tenantId, input.name, id);

  await db.transaction(async trx => {
    await trx("teams").where({ id }).update({ name: input.name, description: input.description || null, color: input.color });
    if ("members" in (req.body ?? {})) await replaceMembers(trx, tenantId, id, input.members);
  });
  res.json(await findTeam(db, tenantId, id));
});

router.delete("/:id", requirePermission("directory.teams.manage"), async (req, res) => {
  const id = parseId(req.params.id);
  const db = getDb();
  await findTeam(db, req.user.tenant_id, id);
  await db("teams").where({ id }).delete(); // members cascade; tickets keep their history with no team
  res.status(204).end();
});

export default router;
