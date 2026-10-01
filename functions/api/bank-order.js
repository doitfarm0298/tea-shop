// 銀行振込の注文を受け付けて、お客様とお店にメールを送る
// 必要な環境変数(Cloudflare Pages の Settings → Variables and secrets):
//   SQUARE_ACCESS_TOKEN … 金額を Square の商品データで確認するため(設定済み)
//   RESEND_API_KEY      … メール送信用(Resend の API キー)
//   SQUARE_ENV          … "sandbox" のときだけテスト環境(通常は未設定)

const SHOP_EMAIL = 'info@doitfarm.com';
const FROM = 'DOIT!FARM! <info@doitfarm.com>';
const SHIPPING_FLAT = 900;
const FREE_SHIPPING_MIN = 8000;
const BANK_TEXT = [
  'GMOあおぞらネット銀行 ビジネス第二支店(202)',
  '普通 1107638',
  '口座名義: ドウーイツトフアーム フクヤ ケンジ',
].join('\n');

const yen = (n) => '¥' + Number(n).toLocaleString('ja-JP');
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequestPost({ request, env }) {
  if (!env.RESEND_API_KEY || !env.SQUARE_ACCESS_TOKEN) {
    return json({ error: 'メール送信の設定が完了していません' }, 500);
  }

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: '送信内容を読み取れませんでした' }, 400); }

  const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
  const c = body.customer || {};
  const orderNumber = String(body.orderNumber || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 20);

  // --- 入力チェック ---
  const required = ['lastName', 'firstName', 'email', 'phone', 'postal', 'pref', 'city', 'address1'];
  if (required.some((k) => !String(c[k] || '').trim())) return json({ error: 'お届け先に未入力の項目があります' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return json({ error: 'メールアドレスの形式が正しくありません' }, 400);
  if (!orderNumber) return json({ error: '注文番号がありません' }, 400);
  if (items.length === 0) return json({ error: 'カートが空です' }, 400);
  for (const it of items) {
    const q = Number(it.quantity);
    if (!it.variationId || !Number.isInteger(q) || q < 1 || q > 99) return json({ error: '数量が正しくありません' }, 400);
  }

  // --- Square の商品データで金額を確認 ---
  const base = env.SQUARE_ENV === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  let objects = [];
  try {
    const res = await fetch(base + '/v2/catalog/batch-retrieve', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.SQUARE_ACCESS_TOKEN,
        'Square-Version': '2024-12-18',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ object_ids: [...new Set(items.map((i) => i.variationId))] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('catalog');
    objects = data.objects || [];
  } catch (e) {
    return json({ error: '商品情報を確認できませんでした' }, 502);
  }

  let subtotal = 0;
  const lines = [];
  for (const it of items) {
    const obj = objects.find((o) => o.id === it.variationId && o.type === 'ITEM_VARIATION');
    const amount = obj && obj.item_variation_data && obj.item_variation_data.price_money
      ? Number(obj.item_variation_data.price_money.amount) : null;
    if (amount === null) return json({ error: '取り扱いのない商品がカートに含まれています。ページを再読み込みしてください。' }, 400);
    const q = Number(it.quantity);
    subtotal += amount * q;
    const label = String(it.name || '商品').slice(0, 60) + (it.weight ? `(${String(it.weight).slice(0, 30)})` : '');
    lines.push(`・${label} × ${q}  ${yen(amount * q)}`);
  }
  const shipping = subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FLAT;
  const total = subtotal + shipping;

  const zip7 = String(c.postal).replace(/\D/g, '');
  const zip = zip7.length === 7 ? zip7.slice(0, 3) + '-' + zip7.slice(3) : c.postal;
  const name = `${c.lastName} ${c.firstName}`;
  const address = `〒${zip} ${c.pref}${c.city}${c.address1}${c.address2 ? ' ' + c.address2 : ''}`;

  const orderBlock = [
    `注文番号: ${orderNumber}`,
    '',
    '【ご注文内容】',
    ...lines,
    '',
    `小計: ${yen(subtotal)}`,
    `送料: ${shipping === 0 ? '無料' : yen(shipping)}`,
    `合計: ${yen(total)}(税込)`,
    '※価格はすべて税込です',
    '',
    '【お届け先】',
    name + ' 様',
    address,
    `電話番号: ${c.phone}`,
  ].join('\n');

  const customerText = [
    `${name} 様`,
    '',
    'このたびはDOIT!FARM!のお茶をご注文いただき、ありがとうございます。',
    '以下の内容でご注文を承りました。',
    '',
    orderBlock,
    '',
    '━━━━━━━━━━━━━━',
    '【お振込先】',
    BANK_TEXT,
    '',
    `お振込金額: ${yen(total)}(税込・送料込み)`,
    '━━━━━━━━━━━━━━',
    '',
    'ご注文者様と異なる名義の口座からお振込みの場合は、',
    `振込名義をご注文者様のお名前(${c.lastName} ${c.firstName} 様)にしてください。`,
    'ご入金を確認後、発送してあらためてご連絡いたします。',
    '',
    '沖縄県・離島へのお届けの場合、追加送料についてご連絡することがあります。',
    'ご不明な点は、このメールにご返信ください。',
    '',
    '--',
    'DOIT!FARM!',
    '京都府木津川市加茂町山田西山田20',
    'https://doitfarm.com',
    SHOP_EMAIL,
  ].join('\n');

  const shopText = [
    '銀行振込の注文が入りました。',
    '',
    orderBlock,
    `メール: ${c.email}`,
    '',
    `入金予定額: ${yen(total)}(税込)`,
  ].join('\n');

  const send = (payload) => fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  // お店への通知(これが届かないと注文を受けられないので、失敗したらエラーにする)
  const shopRes = await send({
    from: FROM, to: [SHOP_EMAIL], reply_to: c.email,
    subject: `【銀行振込】新しいご注文 ${orderNumber}(${name} 様・${yen(total)})`,
    text: shopText,
  });
  if (!shopRes.ok) return json({ error: 'ご注文を送信できませんでした' }, 502);

  // お客様への確認メール
  const custRes = await send({
    from: FROM, to: [c.email], reply_to: SHOP_EMAIL,
    subject: `【DOIT!FARM!】ご注文ありがとうございます(注文番号 ${orderNumber})`,
    text: customerText,
  });

  return json({ ok: true, orderNumber, subtotal, shipping, total, customerMailSent: custRes.ok });
}
