// Suggested questions to ask the agent, and things to check in person.
// Keys are stable so a member's ticks and answers stay attached.

const ASK_SALE = [
  ['s-why', 'Why are the owners selling?'],
  ['s-method', 'How is it being sold (auction, tender, deadline) and when?'],
  ['s-price', 'Is there a price guide, and have there been any offers?'],
  ['s-reports', 'Is there a LIM, building report or title I can see?'],
  ['s-work', 'Has any building work been done, and was it consented?'],
  ['s-chattels', 'What chattels are included in the sale?'],
  ['s-heat', 'What insulation and heating does it have?'],
  ['s-rates', 'What are the annual council rates?'],
  ['s-bodycorp', 'If it’s a unit or apartment – what are the body corporate fees?']
];

const ASK_RENT = [
  ['r-available', 'When is it available, and how long is the lease?'],
  ['r-hhs', 'Does it meet the Healthy Homes standards? Can I see the statement?'],
  ['r-included', 'What’s included – whiteware, curtains, internet?'],
  ['r-pets', 'Are pets allowed?'],
  ['r-bond', 'How much is the bond, and how is rent paid?'],
  ['r-power', 'What are typical power and water costs?'],
  ['r-maint', 'How are maintenance requests handled?'],
  ['r-apply', 'How do I apply, and when will you decide?']
];

const CHECK_ALL = [
  ['c-damp', 'Signs of damp or mould – ceilings, wardrobes, behind curtains'],
  ['c-water', 'Water pressure and hot water in the shower and kitchen'],
  ['c-heating', 'Heating – heat pump, fire, and does it feel well insulated?'],
  ['c-sun', 'Which way the living areas face, and how much sun they get'],
  ['c-noise', 'Noise from the street, neighbours or flight paths'],
  ['c-reception', 'Phone reception, and is fibre available?'],
  ['c-storage', 'Storage – wardrobes, linen cupboard, garage'],
  ['c-parking', 'Parking – off-street, garage or street only']
];

const CHECK_SALE = [
  ['c-roof', 'Condition of the roof, gutters and cladding'],
  ['c-movement', 'Uneven floors or cracks in walls (signs of movement)']
];

const CHECK_RENT = [
  ['c-security', 'Locks on doors and windows, and working smoke alarms']
];

function suggestionsFor(listingType) {
  const rent = listingType === 'For rent';
  const ask = (rent ? ASK_RENT : ASK_SALE).map(([key, text]) => ({ key, kind: 'ask', text }));
  const check = [...CHECK_ALL, ...(rent ? CHECK_RENT : CHECK_SALE)].map(([key, text]) => ({ key, kind: 'check', text }));
  return [...ask, ...check];
}

// Merge suggestions with the member's saved ticks/answers and their own custom items.
function buildChecklist(listingType, saved) {
  const byKey = new Map(saved.map((r) => [r.key, r]));
  const items = suggestionsFor(listingType).map((s) => {
    const r = byKey.get(s.key);
    return { ...s, custom: false, done: !!(r && r.done), answer: (r && r.answer) || '' };
  });
  for (const r of saved) {
    if (r.custom) items.push({ key: r.key, kind: r.kind, text: r.text, custom: true, done: !!r.done, answer: r.answer || '' });
  }
  return items;
}

const DEFAULT_CATEGORIES = ['Light', 'Layout', 'Condition', 'Kitchen', 'Bathroom', 'Outdoor space', 'Storage', 'Neighbourhood'];

module.exports = { suggestionsFor, buildChecklist, DEFAULT_CATEGORIES };
