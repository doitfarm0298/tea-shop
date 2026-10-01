// 発送完了メールを送る(お店専用)
// 必要な環境変数:
//   RESEND_API_KEY … メール送信用(設定済み)
//   ADMIN_PASSWORD … 発送連絡ページのパスワード(新しく設定)

const SHOP_EMAIL = 'info@doitfarm.com';
const FROM = 'DOIT!FARM! <info@doitfarm.com>';
const METHODS = ['ゆうパック', 'ゆうパケット', 'クリックポスト', 'ゆうパケットポスト'];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// 長さに関係なく同じ時間で比べる(パスワード総当たり対策)
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  if (!env.RESEND_API_KEY || !env.ADMIN_PASSWORD) return json({ error: 'サーバーの設定が完了していません' }, 500);

  let b;
  try { b = await request.json(); } catch (e) { return json({ error: '送信内容を読み取れませんでした' }, 400); }

  if (!safeEqual(b.password || '', env.ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 1500));
    return json({ error: 'パスワードが違います' }, 401);
  }

  const name = String(b.name || '').trim().slice(0, 60);
  const email = String(b.email || '').trim().slice(0, 120);
  const orderNumber = String(b.orderNumber || '').trim().slice(0, 40);
  const method = METHODS.includes(b.method) ? b.method : 'ゆうパック';
  const tracking = String(b.tracking || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 20);
  const note = String(b.note || '').trim().slice(0, 500);
  const test = b.test === true;

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'お名前とメールアドレスを確認してください' }, 400);
  if (!tracking) return json({ error: 'お問い合わせ番号(追跡番号)を入力してください' }, 400);

  const trackUrl = `https://trackings.post.japanpost.jp/services/srv/search/direct?searchKind=S002&locale=ja&reqCodeNo1=${tracking}`;

  const text = [
    `${name} 様`,
    '',
    'このたびはDOIT!FARM!のお茶をご注文いただき、ありがとうございます。',
    '本日、ご注文の商品を発送いたしました。',
    '',
    orderNumber ? `注文番号: ${orderNumber}` : null,
    `配送方法: 日本郵便(${method})`,
    `お問い合わせ番号: ${tracking}`,
    '',
    '▼ 配達状況はこちらから確認できます',
    trackUrl,
    '※反映まで少し時間がかかる場合があります。',
    note ? '' : null,
    note || null,
    '',
    '到着まで、今しばらくお待ちください。',
    '届いたお茶を楽しんでいただけたら嬉しいです。',
    'ご不明な点は、このメールにご返信ください。',
    '',
    '--',
    'DOIT!FARM! 自然栽培の宇治茶',
    '京都府木津川市加茂町山田西山田20',
    'https://doitfarm.com',
    SHOP_EMAIL,
  ].filter((l) => l !== null).join('\n');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [test ? SHOP_EMAIL : email],
      bcc: test ? undefined : [SHOP_EMAIL],
      reply_to: SHOP_EMAIL,
      subject: `${test ? '【テスト】' : ''}【DOIT!FARM!】商品を発送しました${orderNumber ? `(注文番号 ${orderNumber})` : ''}`,
      text,
    }),
  });
  if (!res.ok) return json({ error: 'メールを送信できませんでした' }, 502);
  return json({ ok: true, sentTo: test ? SHOP_EMAIL : email });
}
