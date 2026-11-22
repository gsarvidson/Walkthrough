// The page an agent sees when they open a visitor's feedback link.
// Shows only what the visitor chose to share. No login needed.

const TZ = 'Pacific/Auckland';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (o) => (iso) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, ...o }).format(new Date(iso)).replace(',', '');
const fmtDate = fmt({ weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtTime = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });

const HEART_ON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="#E11D48" aria-hidden="true"><path d="M12 20.7l-1.4-1.3C5.4 14.7 2 11.6 2 7.8 2 4.7 4.4 2.3 7.5 2.3c1.7 0 3.4.8 4.5 2.1 1.1-1.3 2.8-2.1 4.5-2.1 3.1 0 5.5 2.4 5.5 5.5 0 3.8-3.4 6.9-8.6 11.6L12 20.7z"/></svg>';
const HEART_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" stroke-width="1.8" aria-hidden="true"><path d="M12 20.7l-1.4-1.3C5.4 14.7 2 11.6 2 7.8 2 4.7 4.4 2.3 7.5 2.3c1.7 0 3.4.8 4.5 2.1 1.1-1.3 2.8-2.1 4.5-2.1 3.1 0 5.5 2.4 5.5 5.5 0 3.8-3.4 6.9-8.6 11.6L12 20.7z"/></svg>';
const LOGO = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 14l2 2 4-4"/></svg>';

const STYLE = `
:root{--ink:#16181D;--muted:#5B6270;--body:#4B5260;--ground:#F3F4F6;--surface:#fff;--accent:#0F766E;--soft:#ECF5F3}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
h1,h2,.brand{font-family:'Space Grotesk',Inter,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:20px 16px 40px;display:flex;flex-direction:column;gap:14px}
.logo{display:flex;align-items:center;gap:8px}
.mark{width:28px;height:28px;border-radius:8px;background:var(--accent);display:flex;align-items:center;justify-content:center}
.brand{font-weight:700;font-size:16px}
.card{background:var(--surface);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:10px}
.photo{height:180px;border-radius:16px;background:#E5E7EB center/cover no-repeat}
.label{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.muted{color:var(--body);font-size:14px;line-height:1.45}
h1{margin:0;font-size:24px;line-height:1.2}
.pill{align-self:flex-start;font-size:13px;font-weight:700;padding:4px 12px;border-radius:14px}
.keen{background:#D1FAE5;color:#065F46}.maybe{background:#FEF3C7;color:#78350F}.not{background:#F3F4F6;color:#374151;border:1px solid #D1D5DB}
.rate{display:flex;justify-content:space-between;align-items:center;min-height:40px;border-bottom:1px solid #EEF0F3;font-size:15px}
.rate:last-child{border-bottom:0}
.hearts{display:flex;gap:2px}
blockquote{margin:0;padding:12px 14px;background:var(--ground);border-radius:12px;font-size:15px;line-height:1.5;white-space:pre-wrap}
.note{border-top:1px solid #EEF0F3;padding-top:10px}.note:first-of-type{border-top:0;padding-top:0}
.note b{font-size:12px;color:#0F5F58}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.grid a{aspect-ratio:1;border-radius:10px;background:#E5E7EB center/cover no-repeat;position:relative}
.grid span{position:absolute;left:5px;bottom:5px;font-size:11px;font-weight:600;padding:2px 6px;border-radius:6px;background:#fff;color:var(--ink)}
.btn{display:flex;align-items:center;justify-content:center;min-height:50px;border-radius:12px;font-size:16px;font-weight:600;text-decoration:none;border:0;width:100%;font-family:inherit;cursor:pointer}
.primary{background:var(--accent);color:#fff}.outline{background:#fff;color:var(--accent);border:1.5px solid var(--accent)}
.row{display:flex;gap:10px}.row>*{flex:1}
.done{background:var(--soft);color:#0F5F58;border-radius:12px;padding:12px 14px;font-weight:600;font-size:15px}
.preview{background:#FEF3C7;color:#78350F;border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.45}
.foot{text-align:center;font-size:12px;color:var(--muted);line-height:1.5}
`;

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body>${body}</body></html>`;
}

function renderGonePage() {
  return shell('Feedback unavailable', `<main class="wrap">
    <div class="logo"><div class="mark">${LOGO}</div><span class="brand">Walkthrough</span></div>
    <div class="card"><h1>This feedback is no longer available</h1>
    <p class="muted" style="margin:0">The person who shared it has turned the link off.</p></div></main>`);
}

function renderFeedbackPage({ f, p, ratings, isOwner, token }) {
  const isRent = p.listingType === 'For rent';
  const who = f.shareContact && f.contactName ? f.contactName : 'A Walkthrough user';
  const first = who.split(' ')[0];
  const visit = (p.visits || [])[0];
  const addr = p.address || p.title;
  const shown = f.includeRatings.filter((c) => ratings[c] > 0);
  const notes = (p.notes || []).filter((n) => f.includeNotes.includes(n.id));
  const photos = (p.photos || []).filter((x) => f.includePhotos.includes(x.id));
  const pillCls = { Keen: 'keen', Maybe: 'maybe', 'Not for me': 'not' }[f.interest] || 'not';
  const tel = (f.contactPhone || '').replace(/[^\d+]/g, '');

  const confirmBox = f.confirmed === true
    ? `<div class="done">✓ You confirmed ${esc(first)} attended</div>`
    : f.confirmed === false
      ? `<div class="done" style="background:#F3F4F6;color:#374151">You said ${esc(first)} didn’t attend</div>`
      : `<div class="row" id="confirm-row">
          <button class="btn primary" type="button" onclick="confirmVisit(true)" ${isOwner ? 'disabled' : ''}>Yes, they attended</button>
          <button class="btn outline" type="button" onclick="confirmVisit(false)" ${isOwner ? 'disabled' : ''}>No</button>
        </div>`;

  const body = `<main class="wrap">
  <div class="logo"><div class="mark">${LOGO}</div><span class="brand">Walkthrough</span></div>
  ${isOwner ? `<div class="preview"><b>Preview.</b> This is what the agent sees. Your own visits to this page aren’t counted.</div>` : ''}

  ${p.photoUrl ? `<div class="photo" style="background-image:url('${esc(p.photoUrl)}')" role="img" aria-label="${esc(addr)}"></div>` : ''}
  <div>
    <span class="label">Feedback on your ${isRent ? 'viewing' : 'open home'}</span>
    <h1 style="margin-top:6px">${esc(addr)}</h1>
  </div>

  <section class="card">
    <span style="font-size:17px;font-weight:700">${esc(who)}</span>
    <span class="muted">${visit ? `Checked in ${esc(fmtDate(visit.checkedInAt))} at ${esc(fmtTime(visit.checkedInAt))} · ${esc(visit.kind)}` : ''}</span>
    ${f.interest ? `<span class="pill ${pillCls}">Interest: ${esc(f.interest)}</span>` : ''}
  </section>

  ${shown.length ? `<section class="card"><span class="label">Ratings</span>
    ${shown.map((c) => `<div class="rate"><span>${esc(c)}</span><span class="hearts" aria-label="${ratings[c]} out of 5">${[1, 2, 3, 4, 5].map((i) => (i <= ratings[c] ? HEART_ON : HEART_OFF)).join('')}</span></div>`).join('')}
  </section>` : ''}

  ${f.comment ? `<section class="card"><span class="label">Comments</span><blockquote>${esc(f.comment)}</blockquote></section>` : ''}

  ${notes.length ? `<section class="card"><span class="label">Notes from the viewing</span>
    ${notes.map((n) => `<div class="note"><b>${esc(n.room)}</b><div class="muted" style="color:var(--ink);font-size:15px;white-space:pre-wrap">${esc(n.body)}</div></div>`).join('')}
  </section>` : ''}

  ${photos.length ? `<section class="card"><span class="label">Photos</span><div class="grid">
    ${photos.map((x) => `<a href="/f/${esc(token)}/photo/${x.id}" target="_blank" rel="noopener" style="background-image:url('/f/${esc(token)}/photo/${x.id}')" aria-label="Photo – ${esc(x.room)}"><span>${esc(x.room)}</span></a>`).join('')}
  </div></section>` : ''}

  ${f.shareContact ? `<section class="card"><span class="label">Contact ${esc(first)}</span>
    <span class="muted" style="color:var(--ink)">${esc([f.contactEmail, f.contactPhone].filter(Boolean).join(' · '))}</span>
    <div class="row">
      ${f.contactEmail ? `<a class="btn primary" href="mailto:${esc(f.contactEmail)}?subject=${encodeURIComponent('Re: ' + addr)}" onclick="logReply('email')">Email</a>` : ''}
      ${tel ? `<a class="btn outline" href="tel:${esc(tel)}" onclick="logReply('call')">Call</a>` : ''}
    </div>
  </section>` : ''}

  <section class="card">
    <span class="label">Did ${esc(first === 'A' ? 'they' : first)} attend?</span>
    <span class="muted">Confirming helps keep feedback genuine. It takes one tap.</span>
    ${confirmBox}
  </section>

  <p class="foot">Shared with you via Walkthrough. The visitor chooses what’s shown here and can turn this link off at any time.</p>
</main>
<script>
const T = ${JSON.stringify(String(token))};
async function confirmVisit(attended) {
  const row = document.getElementById('confirm-row');
  row.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const r = await fetch('/f/' + T + '/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attended }) });
    if (!r.ok) throw new Error((await r.json()).error || 'Something went wrong');
    row.outerHTML = attended ? '<div class="done">\\u2713 Thanks – attendance confirmed</div>' : '<div class="done" style="background:#F3F4F6;color:#374151">Thanks – noted</div>';
  } catch (e) { alert(e.message); row.querySelectorAll('button').forEach((b) => (b.disabled = false)); }
}
function logReply(via) { try { navigator.sendBeacon('/f/' + T + '/reply', new Blob([JSON.stringify({ via })], { type: 'application/json' })); } catch (e) {} }
</script>`;
  return shell(`Feedback – ${addr}`, body);
}

module.exports = { renderFeedbackPage, renderGonePage };
