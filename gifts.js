// Gifts: members earn a point for each viewing an agent confirms they attended.
// At GOAL points they unlock the gift below.

const GOAL = 5;

const GIFT = {
  id: 'moving-10',
  partner: 'The Moving Company',
  title: '10% off your move',
  url: 'https://www.themovingcompany.co.nz/',
  // Placeholder terms until agreed with the partner.
  terms: 'Quote your code when you book. Terms to be confirmed with The Moving Company.'
};

// If the partner gives us one shared code, set GIFT_CODE in Render and everyone gets it.
// Otherwise each member gets their own code (placeholder until the partner confirms how codes work).
function makeCode(randomBytes) {
  if (process.env.GIFT_CODE) return process.env.GIFT_CODE;
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `WALK-${s.slice(0, 3)}-${s.slice(3)}`;
}

module.exports = { GOAL, GIFT, makeCode };
