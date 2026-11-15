// Turning photos, PDFs, web pages and pasted text into a recipe draft the user reviews before saving.
import { supabase } from './supabase';

export type Draft = {
  name: string;
  servings: string;
  minutes: string;
  ings: string;   // one ingredient per line
  steps: string;  // one step per line
  url: string;
  sourceType: 'manual' | 'photo' | 'link' | 'pdf';
  photos: Blob[]; // pictures of the original card, kept with the recipe
  notice: string; // shown above the review form
};

export const emptyDraft = (): Draft => ({ name: '', servings: '', minutes: '', ings: '', steps: '', url: '', sourceType: 'manual', photos: [], notice: '' });

const ING_HEAD = /^(ingredients?|what you(?:'|’)?ll need|you will need)\s*:?$/i;
const STEP_HEAD = /^(directions?|instructions?|method|steps?|preparation|procedure|how to make(?: it)?)\s*:?$/i;
const STARTS_WITH_AMOUNT = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|[½¼¾⅓⅔⅛])(\s|[a-zA-Z(])/;
const STEP_MARKER = /^(?:step\s*)?\d+\s*[.):-]\s+/i;

/** Joins lines that a scan split mid-sentence, so each step is one line. */
function joinSteps(rows: string[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (prev && !STEP_MARKER.test(row) && !/[.!?:]$/.test(prev)) out[out.length - 1] = prev + ' ' + row;
    else out.push(row);
  }
  return out.map((s) => s.replace(STEP_MARKER, '').trim()).filter(Boolean);
}

const NO_BREAK_AFTER = /\b(?:approx|tbsp|tbs|tsp|oz|lb|lbs|pkg|qt|pt|gal|no|vs|etc|deg|temp|med|lg|sm|inc|dr|mr|mrs|st)$/i;

/** "Mix the flour. Add eggs! Bake." -> three sentences. Leaves "2 tbsp. butter" alone. */
export function splitSentences(text: string): string[] {
  const parts = text.trim().split(/([.!?]+["')\]]*)\s+/);
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i];
    const end = parts[i + 1] || '';
    current += body + end;
    const next = parts[i + 2] || '';
    const justANumber = /^(?:step\s*)?\d+$/i.test(current.trim().replace(/[.)]+$/, ''));
    const canBreak = end && /^["'(]?[A-Z0-9]/.test(next) && !NO_BREAK_AFTER.test(body) && !justANumber && current.trim().length >= 10;
    if (canBreak || i + 2 >= parts.length) { if (current.trim()) out.push(current.trim()); current = ''; }
    else current += ' ';
  }
  return out;
}

/** For the review screen: every sentence becomes its own step. */
export function oneStepPerSentence(stepsText: string): string {
  return stepsText.split('\n').flatMap((line) => splitSentences(line)).filter(Boolean).join('\n');
}

/** For the review screen: "2 cups flour, 1 tsp salt and 3 eggs" becomes three lines. */
export function oneIngredientPerLine(ingsText: string): string {
  return ingsText
    .split('\n')
    .flatMap((line) => line.split(/\s*[,;]\s+(?=\d|[½¼¾⅓⅔⅛])|\s+and\s+(?=\d|[½¼¾⅓⅔⅛])/))
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** A paragraph with "1. ... 2. ..." written inline is split at each number; long paragraphs at each sentence. */
function breakUpBlock(step: string): string[] {
  const numbered = step.split(/\s+(?=(?:step\s*)?\d{1,2}\s*[.)]\s+[A-Z])/i).map((s) => s.replace(STEP_MARKER, '').trim()).filter(Boolean);
  if (numbered.length > 1) return numbered;
  const sentences = splitSentences(step);
  return sentences.length >= 3 || step.length > 220 ? sentences : [step];
}

const END_OF_RECIPE = /^(notes?|recipe notes?|nutrition(?:al)?(?: facts| information| info)?|tips?(?: and tricks)?|reviews?|comments?|leave a (?:comment|reply|review)|you (?:might|may) also like|related(?: recipes)?|more recipes|did you make this.*|rate this recipe|tried this recipe.*)\s*:?$/i;
const PAGE_CLUTTER = /^(skip to .*|menu|search|log ?in|sign ?in|subscribe|home|print|pin|share|save|jump to recipe|print recipe|pin recipe|advertisement|cook mode.*|prevent your screen.*|\d+x)$/i;

/** Best-effort sorting of loose text into a name, ingredients and steps. The user fixes the rest. */
export function textToDraft(text: string): Draft {
  const rows = text.split(/\r?\n/).map((l) => l.replace(/^[•\-*·▪◦●□☐▢✓]\s*/, '').replace(/\s+/g, ' ').trim()).filter((l) => l && !PAGE_CLUTTER.test(l));
  const draft = emptyDraft();
  if (!rows.length) return draft;

  const serves = text.match(/(?:serves|servings|yield|yields|makes)\s*:?\s*(\d+)/i);
  if (serves) draft.servings = serves[1];

  const isHead = (r: string) => ING_HEAD.test(r) || STEP_HEAD.test(r);
  const firstHead = rows.findIndex(isHead);
  const titleRow = rows.findIndex((r) => !isHead(r));
  const hasTitle = titleRow >= 0 && (firstHead < 0 || titleRow < firstHead);
  if (hasTitle) draft.name = rows[titleRow];
  const rest = rows.filter((_, n) => !(hasTitle && n === titleRow));
  const ingAt = rest.findIndex((r) => ING_HEAD.test(r));
  const stepAt = rest.findIndex((r) => STEP_HEAD.test(r));

  let ings: string[] = [];
  let steps: string[] = [];
  if (ingAt >= 0 && stepAt >= 0) {
    if (ingAt < stepAt) { ings = rest.slice(ingAt + 1, stepAt); steps = rest.slice(stepAt + 1); }
    else { steps = rest.slice(stepAt + 1, ingAt); ings = rest.slice(ingAt + 1); }
  } else if (stepAt >= 0) {
    ings = rest.slice(0, stepAt);
    steps = rest.slice(stepAt + 1);
  } else {
    // No "Directions" heading: short lines that start with an amount are ingredients.
    for (const row of rest.filter((r) => !isHead(r))) {
      const hasAmount = STARTS_WITH_AMOUNT.test(row) && row.length < 70 && !STEP_MARKER.test(row);
      // A short line with no full stop, in the middle of the ingredients ("salt"), is one too.
      const shortItem = ings.length > 0 && steps.length === 0 && row.length < 30 && !/[.!?]$/.test(row);
      (hasAmount || shortItem ? ings : steps).push(row);
    }
  }
  ings = ings.filter((r) => !/^(?:serves|servings|yield|yields|makes)\b/i.test(r));
  // Text copied from a web page carries on past the recipe (notes, nutrition, comments): stop there.
  const cut = (list: string[]) => { const end = list.findIndex((r) => END_OF_RECIPE.test(r)); return end >= 0 ? list.slice(0, end) : list; };
  ings = cut(ings);
  steps = cut(steps);
  draft.ings = oneIngredientPerLine(ings.join('\n'));
  draft.steps = joinSteps(steps).flatMap(breakUpBlock).join('\n');
  return draft;
}

// ---------------------------------------------------------------- photos

/** Reads the text in photos, on the phone itself. progress goes 0..1. */
export async function readPhotos(photos: Blob[], onProgress: (p: number) => void): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  let index = 0;
  const worker = await createWorker('eng', 1, {
    logger: (m: any) => { if (m.status === 'recognizing text') onProgress((index + m.progress) / photos.length); },
  });
  try {
    const parts: string[] = [];
    for (index = 0; index < photos.length; index++) {
      const { data } = await worker.recognize(photos[index]);
      parts.push(data.text);
    }
    onProgress(1);
    return parts.join('\n');
  } finally {
    await worker.terminate();
  }
}

// ---------------------------------------------------------------- PDFs

/** Gets the text out of a PDF. Scanned PDFs (pictures of pages) are read like photos. */
export async function readPdf(file: File, onProgress: (p: number) => void): Promise<{ text: string; scanned: boolean }> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pageCount = Math.min(pdf.numPages, 8);

  const parts: string[] = [];
  for (let n = 1; n <= pageCount; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    let line = '';
    let lastY: number | null = null;
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) { parts.push(line); line = ''; }
      line += item.str;
      if (item.hasEOL) { parts.push(line); line = ''; }
      lastY = y;
    }
    if (line) parts.push(line);
    onProgress((n / pageCount) * 0.3);
  }
  const text = parts.join('\n');
  if (text.replace(/\s/g, '').length > 40) { onProgress(1); return { text, scanned: false }; }

  // No real text inside: draw each page as a picture and read it.
  const images: Blob[] = [];
  for (let n = 1; n <= pageCount; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport } as any).promise;
    images.push(await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('Could not read a page'))), 'image/jpeg', 0.9)));
  }
  return { text: await readPhotos(images, (p) => onProgress(0.3 + p * 0.7)), scanned: true };
}

// ---------------------------------------------------------------- web links

function decode(html: unknown): string {
  if (typeof html !== 'string') return '';
  const box = document.createElement('textarea');
  box.innerHTML = html.replace(/<[^>]+>/g, ' ');
  return box.value.replace(/\s+/g, ' ').trim();
}

/** "PT1H30M" -> 90 */
function isoMinutes(v: unknown): number {
  const m = typeof v === 'string' ? v.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i) : null;
  return m ? Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
}

function findRecipe(node: any): any {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const n of node) { const hit = findRecipe(n); if (hit) return hit; } return null; }
  const type = node['@type'];
  if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) return node;
  return findRecipe(node['@graph']) || findRecipe(node.mainEntity);
}

function instructionLines(node: any): string[] {
  if (!node) return [];
  if (typeof node === 'string') return node.split(/\n+/).map(decode).filter(Boolean);
  if (Array.isArray(node)) return node.flatMap(instructionLines);
  if (node.itemListElement) return instructionLines(node.itemListElement);
  return [decode(node.text || node.name)].filter(Boolean);
}

/** Most recipe sites describe the recipe in a hidden, standard block. This reads it. */
export function pageToDraft(html: string, url: string): Draft | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let recipe: any = null;
  for (const tag of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try { recipe = findRecipe(JSON.parse(tag.textContent || '')); } catch { /* malformed block, try the next */ }
    if (recipe) break;
  }
  if (!recipe) return null;
  const draft = emptyDraft();
  draft.sourceType = 'link';
  draft.url = url;
  draft.name = decode(recipe.name);
  const yieldValue = Array.isArray(recipe.recipeYield) ? recipe.recipeYield[0] : recipe.recipeYield;
  draft.servings = String(yieldValue ?? '').match(/\d+/)?.[0] || '';
  const minutes = isoMinutes(recipe.totalTime) || isoMinutes(recipe.prepTime) + isoMinutes(recipe.cookTime);
  draft.minutes = minutes ? String(minutes) : '';
  draft.ings = (Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : []).map(decode).filter(Boolean).join('\n');
  draft.steps = instructionLines(recipe.recipeInstructions).join('\n');
  return draft;
}

/** Web pages cannot be fetched straight from the app, so a small helper in Supabase fetches them. */
export async function readLink(rawUrl: string): Promise<Draft> {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { throw new Error('That does not look like a web address.'); }

  const { data, error } = await supabase.functions.invoke('fetch-recipe', { body: { url } });
  if (error) {
    const status = (error as any).context?.status;
    // A helper that does not exist yet shows up as a failed request, not a tidy "not found".
    if ((error as any).name === 'FunctionsFetchError') throw new Error('Link import could not be reached. Either you are offline, or the fetch-recipe helper has not been added in Supabase yet.');
    if (status === 404) throw new Error('Link import is not switched on yet (the fetch-recipe helper has not been added in Supabase).');
    let detail = '';
    try { detail = (await (error as any).context?.json())?.error || ''; } catch { /* no detail */ }
    if (/\((401|403|429|503)\)/.test(detail)) throw new Error('This site does not let apps read its pages. Open the page in Safari, copy the recipe text, and use "Paste text" instead.');
    throw new Error(detail || 'Could not open that page. Check the address and your connection.');
  }
  const draft = pageToDraft(String(data?.html || ''), url);
  if (!draft) throw new Error('No recipe was found on that page. You can copy the recipe text and use "Paste text" instead.');
  draft.notice = 'Pulled from the web page. Check it over and edit anything before saving.';
  return draft;
}
