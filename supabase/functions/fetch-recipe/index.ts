// Supabase Edge Function: fetch-recipe
// Fetches a web page on behalf of a signed-in member so the app can read the recipe on it.
// (Phones are not allowed to fetch other websites' pages directly; a server has to do it.)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Never fetch addresses inside a private network.
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.includes(':') ||
    /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'Use POST' }, 405);

  // Only signed-in people may use this: ask Supabase who the caller is.
  const who = await fetch(Deno.env.get('SUPABASE_URL') + '/auth/v1/user', {
    headers: { Authorization: req.headers.get('Authorization') ?? '', apikey: req.headers.get('apikey') ?? '' },
  });
  if (!who.ok) return reply({ error: 'Sign in first' }, 401);

  let target: URL;
  try {
    const { url } = await req.json();
    target = new URL(String(url));
  } catch {
    return reply({ error: 'That does not look like a web address.' }, 400);
  }
  if (!['http:', 'https:'].includes(target.protocol) || isPrivateHost(target.hostname)) {
    return reply({ error: 'That address cannot be opened.' }, 400);
  }

  try {
    const page = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!page.ok) return reply({ error: `That site answered with an error (${page.status}).` }, 502);
    const html = (await page.text()).slice(0, 3_000_000);
    return reply({ html });
  } catch {
    return reply({ error: 'Could not reach that site.' }, 502);
  }
});
