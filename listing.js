// Turns Trade Me watchlist items + listing details into Walkthrough property records.

function parseTmDate(s) {
  if (!s) return null;
  const m = /\/Date\((-?\d+)/.exec(String(s));
  if (m) return new Date(Number(m[1])).toISOString();
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t).toISOString();
}

function isProperty(item) {
  const path = String(item.CategoryPath || '').toLowerCase();
  return path.includes('trade-me-property') || String(item.Category || '').startsWith('0350');
}

function listingType(path) {
  const p = String(path || '').toLowerCase();
  if (p.includes('rent') || p.includes('flatmate')) return 'For rent';
  return 'For sale';
}

function attr(detail, ...names) {
  const list = (detail && detail.Attributes) || [];
  for (const n of names) {
    const a = list.find((x) => String(x.Name || '').toLowerCase() === n);
    if (a) return a.Value || a.DisplayValue || null;
  }
  return null;
}

function mapAgent(detail) {
  const agency = detail && detail.Agency;
  if (!agency) return null;
  const a = (agency.Agents && agency.Agents[0]) || {};
  return {
    agency: agency.Name || null,
    name: a.FullName || null,
    position: a.Position || null,
    email: a.EMail || a.EmailAddress || a.Email || null,
    mobile: a.MobilePhoneNumber || null,
    office: a.OfficePhoneNumber || agency.PhoneNumber || null,
    phone: a.MobilePhoneNumber || a.OfficePhoneNumber || agency.PhoneNumber || null,
    photo: a.Photo || null
  };
}

function mapListing(item, detail, webBase) {
  const d = detail || {};
  const path = item.CategoryPath || d.CategoryPath || '';
  const photo = (d.Photos && d.Photos[0] && d.Photos[0].Value && (d.Photos[0].Value.Large || d.Photos[0].Value.Medium)) || item.PictureHref || null;
  const openHomes = (d.OpenHomes || [])
    .map((o) => ({ start: parseTmDate(o.Start), end: parseTmDate(o.End) }))
    .filter((o) => o.start)
    .sort((a, b) => a.start.localeCompare(b.start));

  return {
    listingId: Number(item.ListingId),
    title: item.Title || d.Title || '',
    address: attr(d, 'location') || d.Address || item.Title || '',
    suburb: item.Suburb || d.Suburb || null,
    region: item.Region || d.Region || null,
    price: item.PriceDisplay || d.PriceDisplay || null,
    listingType: listingType(path),
    bedrooms: attr(d, 'bedrooms'),
    bathrooms: attr(d, 'bathrooms'),
    photoUrl: photo,
    listingUrl: `${webBase}/Browse/Listing.aspx?id=${item.ListingId}`,
    openHomes,
    agent: mapAgent(d),
    closesAt: parseTmDate(item.EndDate || d.EndDate)
  };
}

module.exports = { parseTmDate, isProperty, listingType, mapListing };
