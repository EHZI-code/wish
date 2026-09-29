const cheerio = require('cheerio');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = req.query.url;
  if (!url) {
    res.status(400).json({ error: 'url required' });
    return;
  }

  try {
    const target = /^https?:\/\//i.test(url) ? url : 'https://' + url;

    const response = await fetch(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });

    if (!response.ok) {
      res.status(502).json({ error: 'fetch_failed', status: response.status });
      return;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    function meta(prop) {
      return (
        $('meta[property="' + prop + '"]').attr('content') ||
        $('meta[name="' + prop + '"]').attr('content') ||
        ''
      );
    }

    let ldTitle = '';
    let ldImage = '';
    let ldPrice = '';
    let ldCurrency = '';

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
            if (c.image && !ldImage) ldImage = Array.isArray(c.image) ? c.image[0] : c.image;
          });
        });
      } catch (e) {
        // 이 스크립트 태그는 건너뜀
      }
    });

    const title = meta('og:title') || ldTitle || $('title').text() || '';
    const image = meta('og:image') || meta('twitter:image') || ldImage || '';
    const price = meta('product:price:amount') || meta('og:price:amount') || ldPrice || '';
    const currency = meta('product:price:currency') || meta('og:price:currency') || ldCurrency || '';

    let site = '';
    try {
      site = new URL(target).hostname.replace(/^www\./, '');
    } catch (e) {}

    res.status(200).json({
      title: title.slice(0, 200),
      image,
      price: price ? String(price).replace(/[^0-9.]/g, '') : '',
      currency,
      site,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
