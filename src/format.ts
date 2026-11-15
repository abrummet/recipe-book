// Amounts, units, and turning typed lines into ingredients and steps.

export type Ing = { qty: number | null; unit: string | null; name: string };
export type Step = { text: string; minutes: number | null };

const GLYPHS: Record<string, number> = { '½': 1 / 2, '¼': 1 / 4, '¾': 3 / 4, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 1 / 8 };
const FRACTIONS: [number, string, string][] = [
  [0, '', ''], [1 / 8, '⅛', '1/8'], [1 / 4, '¼', '1/4'], [1 / 3, '⅓', '1/3'],
  [1 / 2, '½', '1/2'], [2 / 3, '⅔', '2/3'], [3 / 4, '¾', '3/4'], [1, '+', '+'],
];

function nearestFraction(frac: number) {
  let best = FRACTIONS[0];
  for (const f of FRACTIONS) if (Math.abs(f[0] - frac) < Math.abs(best[0] - frac)) best = f;
  return best;
}

/** 1.5 -> "1½" for display. */
export function fmtQty(n: number): string {
  if (n >= 20) return String(Math.round(n));
  const whole = Math.floor(n + 1e-6);
  const best = nearestFraction(n - whole);
  if (best[1] === '+') return String(whole + 1);
  return (whole ? String(whole) : '') + best[1] || '0';
}

/** 1.5 -> "1 1/2" for the edit box, so it can be typed on any keyboard. */
function qtyToText(n: number): string {
  const whole = Math.floor(n + 1e-6);
  const frac = n - whole;
  const best = nearestFraction(frac);
  if (Math.abs(best[0] - frac) > 0.01) return String(Math.round(n * 100) / 100);
  if (best[2] === '+') return String(whole + 1);
  return [whole ? String(whole) : '', best[2]].filter(Boolean).join(' ') || '0';
}

const UNIT_WORDS: Record<string, string> = {
  cup: 'cup', cups: 'cup', c: 'cup',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbsp: 'tbsp', tbs: 'tbsp', tbl: 'tbsp',
  teaspoon: 'tsp', teaspoons: 'tsp', tsp: 'tsp',
  ounce: 'oz', ounces: 'oz', oz: 'oz',
  pound: 'lb', pounds: 'lb', lb: 'lb', lbs: 'lb',
  gram: 'g', grams: 'g', g: 'g',
  kilogram: 'kg', kilograms: 'kg', kg: 'kg',
  milliliter: 'ml', milliliters: 'ml', ml: 'ml',
  liter: 'l', liters: 'l', l: 'l',
  pint: 'pt', pints: 'pt', pt: 'pt',
  quart: 'qt', quarts: 'qt', qt: 'qt',
};

const TO_METRIC: Record<string, [number, string]> = {
  cup: [240, 'ml'], tbsp: [15, 'ml'], tsp: [5, 'ml'], pt: [473, 'ml'], qt: [946, 'ml'],
  oz: [28.35, 'g'], lb: [453.6, 'g'],
};

/** The amount column for one ingredient, scaled and optionally converted to metric. */
export function fmtAmt(ing: Ing, scale = 1, metric = false): string {
  if (ing.qty == null) return '';
  const v = ing.qty * scale;
  const unit = ing.unit || '';
  if (metric && TO_METRIC[unit]) {
    const [factor, mUnit] = TO_METRIC[unit];
    let m = v * factor;
    if (m >= 1000) return Math.round(m / 100) / 10 + (mUnit === 'ml' ? ' l' : ' kg');
    m = m >= 100 ? Math.round(m / 5) * 5 : Math.round(m);
    return m + ' ' + mUnit;
  }
  if (unit === 'g' || unit === 'ml') return Math.round(v) + ' ' + unit;
  const shown = unit === 'cup' && v > 1 ? 'cups' : unit;
  return fmtQty(v) + (shown ? ' ' + shown : '');
}

/** "1 1/2 cups flour" -> { qty: 1.5, unit: "cup", name: "flour" } */
export function parseIngredient(line: string): Ing {
  const text = line.trim();
  const m = text.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?\s*[½¼¾⅓⅔⅛]?|[½¼¾⅓⅔⅛])\s*(.*)$/);
  if (!m) return { qty: null, unit: null, name: text };
  let qty = 0;
  for (const part of m[1].match(/\d+\/\d+|\d+(?:\.\d+)?|[½¼¾⅓⅔⅛]/g) || []) {
    if (GLYPHS[part] != null) qty += GLYPHS[part];
    else if (part.includes('/')) { const [a, b] = part.split('/').map(Number); qty += b ? a / b : 0; }
    else qty += Number(part);
  }
  const rest = m[2].trim();
  const um = rest.match(/^([A-Za-z]+)\.?\s+(.*)$/);
  if (um) {
    const unit = UNIT_WORDS[um[1].toLowerCase()];
    if (unit) return { qty, unit, name: um[2].replace(/^of\s+/i, '') };
  }
  return { qty, unit: null, name: rest || text };
}

/** Finds a time in a step ("bake 1 hour 15 minutes") so a timer can be offered. */
export function parseStep(line: string): Step {
  const text = line.trim().replace(/^\d+[.)]\s+/, '');
  const h = text.match(/(\d+(?:\.\d+)?)\s*(?:-|to)?\s*\d*\s*(?:hours?|hrs?)\b/i);
  const m = text.match(/(\d+)\s*(?:(?:-|to)\s*\d+\s*)?(?:minutes?|mins?)\b/i);
  const total = Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0));
  return { text, minutes: total > 0 ? total : null };
}

export const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

export function ingredientsToText(ings: Ing[]): string {
  return ings
    .map((i) => [i.qty != null ? qtyToText(i.qty) : '', i.unit || '', i.name].filter(Boolean).join(' '))
    .join('\n');
}

export function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
}

/** A date as YYYY-MM-DD in the phone's own time zone. */
export function isoDate(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
