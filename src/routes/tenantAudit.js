// The tenant's audit log: access, settings, and approval changes, newest first.
import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { validate } from "../utils/http.js";

const router = Router();

router.get("/", async (req, res) => {
  const q = validate(
    z.object({ page: z.coerce.number().int().min(1).default(1), action: z.string().trim().max(40).optional(), search: z.string().trim().max(100).optional() }),
    req.query
  );
  const pageSize = 30;
  const db = getDb();
  const query = db("tenant_audit as a").leftJoin("users as u", "u.id", "a.actor_id").where("a.tenant_id", req.user.tenant_id);
  if (q.action) query.where("a.action", "like", `${q.action}%`);
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    query.where(inner => inner.whereRaw("lower(coalesce(a.target, '')) like ?", [term]).orWhereRaw("lower(coalesce(u.name, '')) like ?", [term]));
  }
  const [{ total }] = await query.clone().count({ total: "*" });
  const rows = await query.select("a.*", "u.name as actor_name").orderBy("a.id", "desc").limit(pageSize).offset((q.page - 1) * pageSize);
  res.json({
    entries: rows.map(row => ({
      id: row.id,
      action: row.action,
      target: row.target,
      details: row.details ? JSON.parse(row.details) : null,
      actor: row.actor_id ? { id: row.actor_id, name: row.actor_name } : null,
      createdAt: row.created_at,
    })),
    page: q.page,
    total: Number(total),
    totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)),
  });
});

export default router;
