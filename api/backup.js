// POST /api/backup  — 로그인한 사용자의 아이템 전체를 csv로 만들어 가입한 이메일로 보낸다.
// 필요한 설정(Vercel > Settings > Environment Variables):
//   GMAIL_USER          보내는 Gmail 주소 (예: name@gmail.com)
//   GMAIL_APP_PASSWORD  그 Gmail에서 만든 "앱 비밀번호" 16자리 (공백은 있어도 됨)
const nodemailer = require('nodemailer');

const SUPABASE_URL = 'https://ukjbqpezqzgfbmgtyltp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vziMDIRtG4w-jz9Uc3h0yA_clIQqKYD';

function q(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}
function kst(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: 'login_required' }); return; }

  const gUser = process.env.GMAIL_USER;
  const gPass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
  if (!gUser || !gPass) { res.status(500).json({ error: 'no_mail_key' }); return; }

  try {
    // 1) 토큰으로 사용자 확인 (이 이메일로만 보낸다)
    const ur = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!ur.ok) { res.status(401).json({ error: 'login_required' }); return; }
    const user = await ur.json();
    const email = user && user.email;
    if (!email) { res.status(400).json({ error: 'no_email' }); return; }

    // 2) 이 사용자의 아이템을 모두 읽기 (1000개씩)
    let all = [];
    for (let from = 0; ; from += 1000) {
      const r = await fetch(SUPABASE_URL + '/rest/v1/items?select=*&order=created_at.desc,id.asc', {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: 'Bearer ' + token,
          'Range-Unit': 'items',
          Range: from + '-' + (from + 999),
        },
      });
      if (!r.ok) { res.status(502).json({ error: 'db_failed', detail: 'status ' + r.status }); return; }
      const rows = await r.json();
      all = all.concat(rows);
      if (rows.length < 1000) break;
    }

    // 3) csv (위시버킷 형식 + 이미지/통화 열). import.html로 그대로 복원할 수 있다.
    const head = ['상품명', '스토어명', '브랜드명', '정가', '할인가', '등록일', '버킷명', '소장템 여부', '상품 링크', '이미지', '통화'];
    const lines = [head.map(q).join(',')];
    all.forEach((it) => {
      lines.push([
        it.title, it.site, '', it.price, it.price, kst(it.created_at),
        it.category, it.purchased ? 'Y' : 'N', it.url, it.image, it.currency,
      ].map(q).join(','));
    });
    const csv = '﻿' + lines.join('\r\n');

    // 4) 메일 발송
    const day = kst(new Date().toISOString()).slice(0, 10);
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: gUser, pass: gPass } });
    try {
      await transporter.sendMail({
        from: 'wish backup <' + gUser + '>',
        to: email,
        subject: 'wish back-up ' + day,
        text: all.length + ' items attached.\n(' + day + ')',
        attachments: [{ filename: 'wish-backup-' + day + '.csv', content: Buffer.from(csv, 'utf8'), contentType: 'text/csv; charset=utf-8' }],
      });
    } catch (e) {
      const detail = e && e.code === 'EAUTH' ? 'Gmail 앱 비밀번호가 맞지 않습니다.' : (e && e.message) || 'mail failed';
      res.status(502).json({ error: 'mail_failed', detail });
      return;
    }
    res.status(200).json({ ok: true, count: all.length });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: e.message });
  }
};
