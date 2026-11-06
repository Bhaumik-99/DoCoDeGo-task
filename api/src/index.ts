import { Hono } from 'hono'

interface Env {
  DB: D1Database
}

type HomeRow = { id: string; name: string }
type MemberRow = { id: string; home_id: string; name: string }
type BillRow = { id: string; home_id: string; title: string; total_cents: number }
type ShareRow = {
  id: string
  bill_id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}
type ShareResponse = { id: string; memberId: string; amountCents: number; paidAt: string | null }

const app = new Hono<{ Bindings: Env }>()

app.onError((error, c) => {
  console.error('Unhandled API error', error)
  return c.json({ error: 'Internal server error' }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

async function readJson(c: { req: { json: <T>() => Promise<T> } }): Promise<unknown> {
  try {
    return await c.req.json<unknown>()
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120
}

function createId(): string {
  return crypto.randomUUID()
}

function shareResponse(row: ShareRow): ShareResponse {
  return {
    id: row.id,
    memberId: row.member_id,
    amountCents: row.amount_cents,
    paidAt: row.paid_at,
  }
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.get('/api/homes/:homeId', async (c) => {
  const home = await c.env.DB.prepare('SELECT id, name FROM homes WHERE id = ?')
    .bind(c.req.param('homeId'))
    .first<HomeRow>()
  if (!home) return c.json({ error: 'Home not found' }, 404)
  return c.json(home)
})

app.post('/api/homes', async (c) => {
  const body = await readJson(c)
  if (!isRecord(body) || !validName(body.name)) {
    return c.json({ error: 'Name must be a non-empty string' }, 422)
  }

  const home: HomeRow = { id: createId(), name: body.name.trim() }
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
    .bind(home.id, home.name)
    .run()
  return c.json(home, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const body = await readJson(c)
  if (!isRecord(body) || !validName(body.name)) {
    return c.json({ error: 'Name must be a non-empty string' }, 422)
  }

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()
  if (!home) return c.json({ error: 'Home not found' }, 404)

  const member: MemberRow = { id: createId(), home_id: homeId, name: body.name.trim() }
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(member.id, member.home_id, member.name)
    .run()
  return c.json({ id: member.id, homeId: member.home_id, name: member.name }, 201)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const body = await readJson(c)
  if (!isRecord(body) || !validName(body.title)) {
    return c.json({ error: 'Title must be a non-empty string' }, 422)
  }
  if (typeof body.totalCents !== 'number' || !Number.isSafeInteger(body.totalCents) || body.totalCents <= 0) {
    return c.json({ error: 'totalCents must be a positive whole number' }, 422)
  }

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()
  if (!home) return c.json({ error: 'Home not found' }, 404)

  const members = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY created_at ASC, rowid ASC',
  ).bind(homeId).all<{ id: string }>()
  if (members.results.length === 0) return c.json({ error: 'Home has no members' }, 422)

  const bill: BillRow = {
    id: createId(),
    home_id: homeId,
    title: body.title.trim(),
    total_cents: body.totalCents,
  }
  const baseAmount = Math.floor(bill.total_cents / members.results.length)
  const remainder = bill.total_cents % members.results.length
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
      .bind(bill.id, bill.home_id, bill.title, bill.total_cents),
  ]
  const shares = members.results.map((member, index) => {
    const share: ShareResponse = {
      id: createId(),
      memberId: member.id,
      amountCents: baseAmount + (index < remainder ? 1 : 0),
      paidAt: null,
    }
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(share.id, bill.id, share.memberId, share.amountCents),
    )
    return share
  })

  await c.env.DB.batch(statements)
  return c.json({
    id: bill.id,
    homeId: bill.home_id,
    title: bill.title,
    totalCents: bill.total_cents,
    shares,
  }, 201)
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) return c.json({ error: 'Idempotency-Key header is required' }, 400)

  const bill = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?')
    .bind(billId)
    .first<{ id: string }>()
  if (!bill) return c.json({ error: 'Bill not found' }, 404)

  const share = await c.env.DB.prepare(
    'SELECT id, bill_id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  ).bind(shareId, billId).first<ShareRow>()
  if (!share) return c.json({ error: 'Share not found' }, 404)

  if (share.paid_at !== null) {
    if (share.idempotency_key === key) return c.json(shareResponse(share))
    return c.json({ error: 'Share has already been paid' }, 409)
  }

  const paidAt = new Date().toISOString()
  const update = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
  ).bind(paidAt, key, shareId, billId).run()

  if (update.meta.changes === 1) {
    return c.json({ id: share.id, memberId: share.member_id, amountCents: share.amount_cents, paidAt })
  }

  const current = await c.env.DB.prepare(
    'SELECT id, bill_id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  ).bind(shareId, billId).first<ShareRow>()
  if (!current) return c.json({ error: 'Share not found' }, 404)
  if (current.paid_at !== null && current.idempotency_key === key) {
    return c.json(shareResponse(current))
  }
  return c.json({ error: 'Share has already been paid' }, 409)
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()
  if (!home) return c.json({ error: 'Home not found' }, 404)

  const rows = await c.env.DB.prepare(`
    SELECT m.id AS member_id, m.name AS name,
      COALESCE(SUM(CASE WHEN s.paid_at IS NULL AND b.id IS NOT NULL THEN s.amount_cents ELSE 0 END), 0) AS outstanding_cents
    FROM members m
    LEFT JOIN shares s ON s.member_id = m.id
    LEFT JOIN bills b ON b.id = s.bill_id AND b.home_id = m.home_id
    WHERE m.home_id = ?
    GROUP BY m.id, m.name, m.created_at
    ORDER BY m.created_at ASC, m.rowid ASC
  `).bind(homeId).all<{ member_id: string; name: string; outstanding_cents: number }>()

  return c.json({
    balances: rows.results.map((row) => ({
      memberId: row.member_id,
      name: row.name,
      outstandingCents: Number(row.outstanding_cents),
    })),
  })
})

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()
  if (!home) return c.json({ error: 'Home not found' }, 404)

  const bills = await c.env.DB.prepare(
    'SELECT id, home_id, title, total_cents FROM bills WHERE home_id = ? ORDER BY created_at DESC, rowid DESC',
  ).bind(homeId).all<BillRow>()
  const output = await Promise.all(bills.results.map(async (bill) => {
    const shares = await c.env.DB.prepare(
      'SELECT id, bill_id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE bill_id = ? ORDER BY rowid ASC',
    ).bind(bill.id).all<ShareRow>()
    const members = await c.env.DB.prepare(
      'SELECT id, name FROM members WHERE id IN (SELECT member_id FROM shares WHERE bill_id = ?)',
    ).bind(bill.id).all<{ id: string; name: string }>()
    const memberNames = new Map(members.results.map((member) => [member.id, member.name]))
    return {
      id: bill.id,
      homeId: bill.home_id,
      title: bill.title,
      totalCents: bill.total_cents,
      shares: shares.results.map((share) => ({
        ...shareResponse(share),
        memberName: memberNames.get(share.member_id) ?? 'Unknown member',
      })),
    }
  }))
  return c.json({ bills: output })
})

export default app
