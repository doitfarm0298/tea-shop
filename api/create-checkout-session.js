// Vercel Serverless Function
// URL: /api/create-checkout-session
//
// フロントエンド (index.html) から
//   { items: [{variationId, quantity}, ...], customer: {...お届け先} }
// を受け取り、Square Checkout API (Payment Links) で決済ページを作成し、その URL を返します。
// アクセストークン (SQUARE_ACCESS_TOKEN) はここ(サーバー側)でのみ使用し、
// 絶対にフロントエンドのコードには書かないでください。
//
// 必要な環境変数:
// SQUARE_ACCESS_TOKEN … Square の アクセストークン(本番 or サンドボックス)
// SQUARE_LOCATION_ID … 決済を紐づける Square のロケーションID
// SQUARE_ENV … "sandbox" にするとテスト環境を使用(それ以外・未設定なら本番)

const SQUARE_API_BASE = process.env.SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

const SQUARE_VERSION = '2025-01-23';

// 送料の設定
// index.html の SHIPPING_FLAT / FREE_SHIPPING_MIN と同じ値にしてください。
const SHIPPING_FLAT = 900;       // 通常の送料(円)
const FREE_SHIPPING_MIN = 8000;  // この金額(商品合計)以上で送料無料(円)

const crypto = require('crypto');

function squareHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
    'Square-Version': SQUARE_VERSION,
  };
}

// 文字列を整える(長すぎる入力は切り詰め)
const clean = (v, max = 100) => String(v == null ? '' : v).trim().slice(0, max);

// 日本の電話番号 → Square が求める国際形式 (+81...)
function toE164JP(phone) {
  const digits = clean(phone, 30).replace(/\D/g, '');
  if (/^0\d{9,10}$/.test(digits)) return '+81' + digits.slice(1);
  return '';
}

// 郵便番号 → 123-4567 の形
function formatPostal(postal) {
  const digits = clean(postal, 20).replace(/\D/g, '');
  return /^\d{7}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3)}` : '';
}

// お届け先情報から、Square の決済画面に最初から入れておく内容を作ります。
function buildPrePopulated(customer, level) {
  if (!customer || typeof customer !== 'object') return null;
  const data = {};

  const email = clean(customer.email, 254);
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) data.buyer_email = email;

  const phone = toE164JP(customer.phone);
  if (phone) data.buyer_phone_number = phone;

  if (level === 'full') {
    const address = {
      first_name: clean(customer.firstName, 50),
      last_name: clean(customer.lastName, 50),
      postal_code: formatPostal(customer.postal),
      administrative_district_level_1: clean(customer.pref, 10),
      locality: clean(customer.city, 100),
      address_line_1: clean(customer.address1, 200),
      address_line_2: clean(customer.address2, 200),
      country: 'JP',
    };
    Object.keys(address).forEach(k => { if (!address[k]) delete address[k]; });
    if (Object.keys(address).length > 1) data.buyer_address = address;
  }

  return Object.keys(data).length ? data : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { items, customer } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'カートが空です' });
      return;
    }

    // 受け取った内容を整えてチェック
    const cleanItems = items.map(i => ({
      variationId: String((i && i.variationId) || ''),
      quantity: parseInt(i && i.quantity, 10),
    }));

    const invalid = cleanItems.find(i =>
      !i.variationId ||
      i.variationId.includes('REPLACE') ||
      !Number.isInteger(i.quantity) ||
      i.quantity < 1 ||
      i.quantity > 99
    );
    if (invalid) {
      res.status(400).json({ error: 'カートの内容に誤りがあります。ページを再読み込みしてやり直してください。' });
      return;
    }

    // Square から商品の価格を取得して、送料をサーバー側で計算します。
    // (ブラウザから送られた送料をそのまま使うと、書き換えられる恐れがあるため)
    const ids = [...new Set(cleanItems.map(i => i.variationId))];
    const catalogRes = await fetch(`${SQUARE_API_BASE}/v2/catalog/batch-retrieve`, {
      method: 'POST',
      headers: squareHeaders(),
      body: JSON.stringify({ object_ids: ids }),
    });
    const catalogData = await catalogRes.json();

    if (!catalogRes.ok) {
      console.error(catalogData);
      res.status(500).json({ error: '商品情報の取得に失敗しました' });
      return;
    }

    const priceById = {};
    (catalogData.objects || []).forEach(obj => {
      const v = obj.item_variation_data;
      if (obj.type === 'ITEM_VARIATION' && v && v.price_money) {
        priceById[obj.id] = Number(v.price_money.amount);
      }
    });

    let subtotal = 0;
    for (const i of cleanItems) {
      if (priceById[i.variationId] === undefined) {
        res.status(400).json({ error: '取り扱いのない商品がカートに含まれています。ページを再読み込みしてください。' });
        return;
      }
      subtotal += priceById[i.variationId] * i.quantity;
    }

    const shippingAmount = subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FLAT;

    const line_items = cleanItems.map(i => ({
      quantity: String(i.quantity),
      catalog_object_id: i.variationId,
    }));

    const origin = req.headers.origin || `https://${req.headers.host}`;

    const checkout_options = {
      // 発送先の住所をお客様に入力してもらいます(配送に必要なため)。
      // 沖縄県・離島への追加送料は自動計算されないので、該当する場合は
      // 届いた注文を確認のうえ、別途ご連絡ください。
      ask_for_shipping_address: true,
      redirect_url: `${origin}/?checkout=success`,
    };

    // 送料は Square の「配送料」として付けます。0円(送料無料)のときは付けません。
    if (shippingAmount > 0) {
      checkout_options.shipping_fee = {
        name: '送料',
        charge: { amount: shippingAmount, currency: 'JPY' },
      };
    }

    // 決済リンクを作成。
    // お届け先の事前入力を Square が受け付けなかった場合に備えて、
    // 「住所まで入れる」→「メール・電話だけ」→「事前入力なし」の順に試します。
    const attempts = ['full', 'contact', 'none'];
    let data = null;
    let response = null;

    for (const level of attempts) {
      const body = {
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: process.env.SQUARE_LOCATION_ID,
          line_items,
        },
        checkout_options,
      };
      const pre = level === 'none' ? null : buildPrePopulated(customer, level);
      if (level !== 'none' && !pre) continue;
      if (pre) body.pre_populated_data = pre;

      response = await fetch(`${SQUARE_API_BASE}/v2/online-checkout/payment-links`, {
        method: 'POST',
        headers: squareHeaders(),
        body: JSON.stringify(body),
      });
      data = await response.json();

      if (response.ok) break;
      console.error(`payment link failed (prefill: ${level})`, JSON.stringify(data));
      // 400 以外(認証エラーなど)は、事前入力を外しても直らないので打ち切り
      if (response.status !== 400) break;
    }

    if (!response || !response.ok) {
      const message = data && data.errors && data.errors[0] ? data.errors[0].detail : '決済セッションの作成に失敗しました';
      res.status(500).json({ error: message });
      return;
    }

    res.status(200).json({ url: data.payment_link.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '決済セッションの作成に失敗しました' });
  }
};
