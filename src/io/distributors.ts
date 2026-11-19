// Distributor search APIs as a fallback for part data the jlcparts catalogue lacks (scripts/parts.ts).
// Pure request building and response parsing, so the parsing is testable without network or keys.
//   Digi-Key Product Information v4: OAuth2 client credentials → /products/v4/search/{pn}/productdetails
//   Mouser Search API v1: POST /api/v1/search/partnumber?apiKey=…
// Field names follow the APIs' JSON; the parsers also accept their documented spelling variants.

export interface PartRecord {
  source: 'jlcparts' | 'digikey' | 'mouser';
  /** Catalogue id (LCSC "C123", Digi-Key or Mouser part number). */
  id: string;
  mfr: string;
  manufacturer: string;
  package: string;
  datasheet: string;
  description: string;
  /** Distributor summary values (mixed typical / maximum): identification only. */
  attributes: Record<string, string>;
}

/** Datasheet links come protocol-relative or with spaces now and then. */
export function cleanUrl(u: string | undefined | null): string {
  if (!u) return '';
  const s = u.trim().replace(/ /g, '%20');
  return s.startsWith('//') ? `https:${s}` : s;
}

export const DIGIKEY = {
  token: 'https://api.digikey.com/v1/oauth2/token',
  details: (pn: string) => `https://api.digikey.com/products/v4/search/${encodeURIComponent(pn)}/productdetails`,
  keyword: 'https://api.digikey.com/products/v4/search/keyword',
};

export const MOUSER = {
  partnumber: (key: string) => `https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(key)}`,
  body: (pn: string) => ({ SearchByPartRequest: { mouserPartNumber: pn, partSearchOptions: 'BeginsWith' } }),
};

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

/** Digi-Key product → record (productdetails returns { Product }, keyword search { Products: [] }). */
export function parseDigikeyProduct(p: Json): PartRecord | null {
  const mfr = str(p.ManufacturerProductNumber ?? p.ManufacturerPartNumber);
  if (!mfr) return null;
  const params: Record<string, string> = {};
  let pkg = '';
  for (const raw of (Array.isArray(p.Parameters) ? p.Parameters : []) as Json[]) {
    const name = str(raw.ParameterText ?? raw.Parameter), value = str(raw.ValueText ?? raw.Value);
    if (!name || !value) continue;
    params[name] = value;
    if (/package \/ case|supplier device package/i.test(name) && !pkg) pkg = value;
  }
  const variations = (Array.isArray(p.ProductVariations) ? p.ProductVariations : []) as Json[];
  return {
    source: 'digikey',
    id: str(variations[0]?.DigiKeyProductNumber ?? p.DigiKeyPartNumber) || mfr,
    mfr,
    manufacturer: str(obj(p.Manufacturer).Name ?? p.Manufacturer),
    package: pkg,
    datasheet: cleanUrl(str(p.DatasheetUrl ?? p.PrimaryDatasheet)),
    description: str(obj(p.Description).ProductDescription ?? obj(p.Description).DetailedDescription ?? p.ProductDescription ?? p.Description),
    attributes: params,
  };
}

/** Digi-Key response (details or keyword search) → the best record for a part number. */
export function parseDigikey(res: unknown, pn: string): PartRecord | null {
  const r = obj(res);
  const list = r.Product ? [obj(r.Product)] : ((Array.isArray(r.Products) ? r.Products : []) as Json[]);
  const recs = list.map(parseDigikeyProduct).filter((x): x is PartRecord => !!x);
  return pickBest(recs, pn);
}

/** Mouser response → the best record for a part number. */
export function parseMouser(res: unknown, pn: string): PartRecord | null {
  const r = obj(res);
  const errors = (Array.isArray(r.Errors) ? r.Errors : []) as Json[];
  if (errors.length) throw new Error(`Mouser: ${errors.map((e) => str(e.Message) || str(e.Code)).join('; ')}`);
  const parts = (Array.isArray(obj(r.SearchResults).Parts) ? obj(r.SearchResults).Parts : []) as Json[];
  const recs = parts.map((p): PartRecord | null => {
    const mfr = str(p.ManufacturerPartNumber);
    if (!mfr) return null;
    const attrs: Record<string, string> = {};
    for (const a of (Array.isArray(p.ProductAttributes) ? p.ProductAttributes : []) as Json[]) {
      const n = str(a.AttributeName), v = str(a.AttributeValue);
      if (n && v) attrs[n] = v;
    }
    return {
      source: 'mouser', id: str(p.MouserPartNumber) || mfr, mfr, manufacturer: str(p.Manufacturer),
      package: attrs['Package / Case'] ?? '', datasheet: cleanUrl(str(p.DataSheetUrl)), description: str(p.Description), attributes: attrs,
    };
  }).filter((x): x is PartRecord => !!x);
  return pickBest(recs, pn);
}

/** Exact part number first, then one that starts with it; prefer records with a datasheet link. */
export function pickBest(recs: PartRecord[], pn: string): PartRecord | null {
  const P = pn.toUpperCase();
  const score = (r: PartRecord) => (r.mfr.toUpperCase() === P ? 4 : r.mfr.toUpperCase().startsWith(P) ? 2 : 0) + (r.datasheet ? 1 : 0);
  const ok = recs.filter((r) => score(r) >= 2).sort((a, b) => score(b) - score(a) || a.mfr.length - b.mfr.length);
  return ok[0] ?? null;
}
