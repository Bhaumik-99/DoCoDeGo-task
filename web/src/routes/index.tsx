import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import '../styles.css'

export const Route = createFileRoute('/')({ component: Home })

type HomeRecord = { id: string; name: string }
type Member = { id: string; homeId: string; name: string }
type Balance = { memberId: string; name: string; outstandingCents: number }
type Share = { id: string; memberId: string; memberName: string; amountCents: number; paidAt: string | null }
type Bill = { id: string; homeId: string; title: string; totalCents: number; shares: Share[] }

const currency = (cents: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2,
}).format(cents / 100)

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.')
  }
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data
      ? String(data.error ?? 'Request failed')
      : `Request failed (${response.status})`
    throw new Error(message)
  }
  return data as T
}

function Home() {
  const [homeId, setHomeId] = useState(() => localStorage.getItem('bill-splitter-home') ?? '')
  const [home, setHome] = useState<HomeRecord | null>(null)
  const [bills, setBills] = useState<Bill[]>([])
  const [balances, setBalances] = useState<Balance[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyShare, setBusyShare] = useState('')
  const [homeName, setHomeName] = useState('')
  const [memberName, setMemberName] = useState('')
  const [billTitle, setBillTitle] = useState('')
  const [billAmount, setBillAmount] = useState('')

  const refresh = useCallback(async (id: string) => {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const [homeData, billsData, balanceData] = await Promise.all([
        request<HomeRecord>(`/api/homes/${encodeURIComponent(id)}`).catch(() => ({ id, name: 'Your shared home' })),
        request<{ bills: Bill[] }>(`/api/homes/${encodeURIComponent(id)}/bills`),
        request<{ balances: Balance[] }>(`/api/homes/${encodeURIComponent(id)}/balances`),
      ])
      setHome(homeData)
      setBills(billsData.bills)
      setBalances(balanceData.balances)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong while loading your home.')
      setBills([])
      setBalances([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (homeId) void refresh(homeId)
  }, [homeId, refresh])

  const totalOutstanding = useMemo(
    () => balances.reduce((total, item) => total + item.outstandingCents, 0),
    [balances],
  )

  async function createHome(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    try {
      const created = await request<HomeRecord>('/api/homes', {
        method: 'POST', body: JSON.stringify({ name: homeName }),
      })
      localStorage.setItem('bill-splitter-home', created.id)
      setHome(created)
      setHomeId(created.id)
      setHomeName('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create home.')
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!homeId) return
    setError('')
    try {
      await request<Member>(`/api/homes/${encodeURIComponent(homeId)}/members`, {
        method: 'POST', body: JSON.stringify({ name: memberName }),
      })
      setMemberName('')
      await refresh(homeId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add member.')
    }
  }

  async function createBill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!homeId) return
    const amount = Number(billAmount)
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setError('Enter a positive whole number of cents.')
      return
    }
    setError('')
    try {
      await request<Bill>(`/api/homes/${encodeURIComponent(homeId)}/bills`, {
        method: 'POST', body: JSON.stringify({ title: billTitle, totalCents: amount }),
      })
      setBillTitle('')
      setBillAmount('')
      await refresh(homeId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create bill.')
    }
  }

  async function payShare(billId: string, shareId: string) {
    setBusyShare(shareId)
    setError('')
    try {
      await request<Share>(`/api/bills/${encodeURIComponent(billId)}/shares/${encodeURIComponent(shareId)}/pay`, {
        method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      await refresh(homeId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Payment failed. Your share remains unpaid.')
    } finally {
      setBusyShare('')
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Sharedspace home"><span className="brand-mark">s.</span> shared<span className="brand-muted">space</span></a>
        <span className="topbar-note">A calmer way to split home expenses</span>
        <span className="avatar">B</span>
      </header>
      <main className="main-content">
        <section className="hero">
          <div>
            <p className="eyebrow">YOUR HOUSEHOLD, IN SYNC</p>
            <h1>Good things are <em>shared.</em></h1>
            <p className="hero-copy">Keep the little things between housemates simple. One place for bills, balances, and peace of mind.</p>
          </div>
          <div className="hero-art" aria-hidden="true"><div className="art-circle circle-one" /><div className="art-circle circle-two" /><div className="art-card"><span>✳</span><strong>Fair shares.</strong><small>Happy home.</small></div></div>
        </section>
        {error && <div className="alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
        {!homeId ? (
          <section className="setup-card">
            <div className="section-kicker">GET STARTED</div>
            <h2>Create your shared home</h2>
            <p>Give your household a name. You can add everyone and start splitting bills right after.</p>
            <form className="inline-form" onSubmit={createHome}>
              <input value={homeName} onChange={(event) => setHomeName(event.target.value)} placeholder="e.g. The Sunday House" required maxLength={120} />
              <button className="primary-button" type="submit">Create home <span>↗</span></button>
            </form>
          </section>
        ) : (
          <>
            <section className="overview-row">
              <div><p className="section-kicker">YOUR HOME</p><h2>{home?.name ?? 'Your shared home'}</h2><p className="subtle">A little more organised, together.</p></div>
              <button className="text-button" type="button" onClick={() => { localStorage.removeItem('bill-splitter-home'); setHomeId(''); setHome(null); setBills([]); setBalances([]) }}>Switch home ↗</button>
            </section>
            <section className="stats-grid">
              <article className="stat-card stat-dark"><span className="stat-label">TOTAL TO SETTLE</span><strong>{currency(totalOutstanding)}</strong><span className="stat-foot">Across all unpaid shares</span><span className="stat-icon">↗</span></article>
              <article className="stat-card"><span className="stat-label">HOUSEMATES</span><strong>{balances.length}</strong><span className="stat-foot">Sharing this home</span><span className="stat-icon pale-icon">♧</span></article>
              <article className="stat-card"><span className="stat-label">ACTIVE BILLS</span><strong>{bills.length}</strong><span className="stat-foot">Tracked together</span><span className="stat-icon pale-icon">▤</span></article>
            </section>
            <section className="workspace-grid">
              <div className="left-column">
                <div className="section-heading"><div><p className="section-kicker">THE BREAKDOWN</p><h2>Recent bills</h2></div><span className="count-pill">{bills.length} bills</span></div>
                {loading ? <div className="state-card"><span className="spinner" />Loading your bills…</div> : bills.length === 0 ? <div className="state-card empty-state"><div className="empty-icon">▤</div><strong>No bills just yet</strong><span>Add your first household expense to get started.</span></div> : <div className="bill-list">{bills.map((bill) => <article className="bill-card" key={bill.id}><div className="bill-top"><div className="bill-symbol">{bill.title.toLowerCase().includes('rent') ? '⌂' : '✳'}</div><div className="bill-title"><h3>{bill.title}</h3><span>{bill.shares.length} people included</span></div><strong>{currency(bill.totalCents)}</strong></div><div className="share-list">{bill.shares.map((share) => <div className="share-row" key={share.id}><div className="member-avatar">{share.memberName.slice(0, 1).toUpperCase()}</div><div className="share-member"><strong>{share.memberName}</strong><span>{share.paidAt ? 'Settled' : 'Awaiting payment'}</span></div><strong className="share-amount">{currency(share.amountCents)}</strong>{share.paidAt ? <span className="paid-chip">Paid ✓</span> : <button className="pay-button" disabled={busyShare === share.id} onClick={() => void payShare(bill.id, share.id)} type="button">{busyShare === share.id ? 'Paying…' : 'Pay share'}</button>}</div>)}</div></article>)}</div>}
              </div>
              <aside className="right-column">
                <section className="panel"><div className="section-heading compact"><div><p className="section-kicker">THE HOUSEHOLD</p><h2>Balances</h2></div><span className="panel-icon">↗</span></div>{balances.length === 0 ? <p className="panel-empty">Add housemates to see their balances here.</p> : balances.map((balance) => <div className="balance-row" key={balance.memberId}><div className="member-avatar large">{balance.name.slice(0, 1).toUpperCase()}</div><div className="balance-name"><strong>{balance.name}</strong><span>Outstanding</span></div><strong>{currency(balance.outstandingCents)}</strong></div>)}</section>
                <section className="panel form-panel"><p className="section-kicker">GROW YOUR HOUSE</p><h2>Add a housemate</h2><p>Bring everyone into the loop.</p><form onSubmit={addMember}><input value={memberName} onChange={(event) => setMemberName(event.target.value)} placeholder="Their name" required maxLength={120} /><button type="submit" className="secondary-button">Add member <span>＋</span></button></form></section>
                <section className="panel form-panel bill-form-panel"><p className="section-kicker">NEW EXPENSE</p><h2>Add a bill</h2><p>Split it equally between your housemates.</p><form onSubmit={createBill}><input value={billTitle} onChange={(event) => setBillTitle(event.target.value)} placeholder="Bill name" required maxLength={120} /><label className="money-input"><span>¢</span><input type="number" min="1" step="1" value={billAmount} onChange={(event) => setBillAmount(event.target.value)} placeholder="Amount in cents" required /></label><button type="submit" className="primary-button full-button">Create bill <span>↗</span></button></form></section>
              </aside>
            </section>
          </>
        )}
        <footer><span>Made for living well, together.</span><span>SHAREDSPACE <b>·</b> SIMPLE BY DESIGN</span></footer>
      </main>
    </div>
  )
}
