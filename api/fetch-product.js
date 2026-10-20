const cheerio = require('cheerio');

const SUPABASE_URL = 'https://ukjbqpezqzgfbmgtyltp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vziMDIRtG4w-jz9Uc3h0yA_clIQqKYD';

// 서버 내부망/자기 자신을 가리키는 주소는 막는다 (로그인한 사람이라도).
function isBlockedHost(h) {
  h = h.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h.includes(':')) return true; // IPv6 직접 입력
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

// 같은 주소를 여러 "신분"으로 차례로 시도한다.
// 쇼핑몰은 일반 브라우저는 막아도 링크 미리보기용 크롤러(페이스북/트위터)는 허용하는 경우가 많다.
const AGENTS = [
  {
    name: 'browser',
    timeout: 4000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    },
  },
  {
    name: 'facebook',
    timeout: 2500,
    headers: {
      'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      Accept: '*/*',
    },
  },
  {
    name: 'twitter',
    timeout: 2500,
    headers: { 'User-Agent': 'Twitterbot/1.0', Accept: '*/*' },
  },
];

async function tryFetch(target, agent) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), agent.timeout);
  try {
    const response = await fetch(target, { headers: agent.headers, signal: ctrl.signal, redirect: 'follow' });
    if (!response.ok) return { ok: false, reason: 'http_' + response.status };
    const html = await response.text();
    return { ok: true, html, finalUrl: response.url || target };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function parse(html, base) {
  const $ = cheerio.load(html);
  function meta(prop) {
    return $('meta[property="' + prop + '"]').attr('content') || $('meta[name="' + prop + '"]').attr('content') || '';
  }
  let ldTitle = '', ldImage = '', ldPrice = '', ldCurrency = '';
  $('script[type="application/ld+json"]').each(function () {
    try {
      const data = JSON.parse($(this).contents().text());
      const list = Array.isArray(data) ? data : [data];
      list.forEach(function (item) {
        const cands = item['@graph'] ? item['@graph'] : [item];
        cands.forEach(function (c) {
          const offers = Array.isArray(c.offers) ? c.offers[0] : c.offers;
          if (offers && offers.price && !ldPrice) {
            ldPrice = String(offers.price);
            ldCurrency = offers.priceCurrency || '';
          }
          if (c.name && !ldTitle) ldTitle = c.name;
          if (c.image && !ldImage) {
            const im = Array.isArray(c.image) ? c.image[0] : c.image;
            ldImage = typeof im === 'string' ? im : (im && im.url) || '';
          }
        });
      });
    } catch (e) {}
  });
  const title = meta('og:title') || ldTitle || $('title').text() || '';
  let image = meta('og:image') || meta('twitter:image') || ldImage || '';
  if (image) {
    try { image = new URL(image, base).href; } catch (e) {}
  }
  const price = meta('product:price:amount') || meta('og:price:amount') || ldPrice || '';
  const currency = meta('product:price:currency') || meta('og:price:currency') || ldCurrency || '';
  return { title: title.trim(), image, price, currency };
}

module.exports = async (req, res) => {
  // 로그인한 사용자만 사용할 수 있다.
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: 'login_required' }); return; }
  try {
    const ur = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!ur.ok) { res.status(401).json({ error: 'login_required' }); return; }
  } catch (e) { res.status(401).json({ error: 'login_required' }); return; }

  const url = req.query.url;
  if (!url) { res.status(400).json({ error: 'url required' }); return; }

  const target = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  try {
    const u = new URL(target);
    if (!/^https?:$/.test(u.protocol) || isBlockedHost(u.hostname)) { res.status(400).json({ error: 'bad_url' }); return; }
  } catch (e) { res.status(400).json({ error: 'bad_url' }); return; }
  let site = '';
  try { site = new URL(target).hostname.replace(/^www\./, ''); } catch (e) {}

  let best = null;       // 이미지는 없어도 제목/가격이라도 얻은 결과
  const reasons = [];
  for (const agent of AGENTS) {
    const r = await tryFetch(target, agent);
    if (!r.ok) { reasons.push(agent.name + ':' + r.reason); continue; }
    const info = parse(r.html, r.finalUrl);
    if (info.image) { best = info; break; }
    reasons.push(agent.name + ':no_image');
    if (!best && (info.title || info.price)) best = info;
  }

  if (best && best.image) {
    res.status(200).json({ title: best.title.slice(0, 200), image: best.image,
      price: best.price ? String(best.price).replace(/[^0-9.]/g, '') : '', currency: best.currency, site });
    return;
  }
  // 이미지를 못 얻음: 이유를 함께 돌려준다
  res.status(502).json({ error: 'no_image', reason: reasons.join(' | '), title: best ? best.title.slice(0, 200) : '', site });
};
