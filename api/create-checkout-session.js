// Vercel Serverless Function
// URL: /api/create-checkout-session
//
// フロントエンド (index.html) から
//   { items: [{variationId, quantity}, ...], customer: {...お届け先} }
// を受け取り、Square Checkout API (Payment Links) で決済ページを作成し、その URL を返します。
//
// お届け先はサイト側で入力してもらい、Square の注文データに添えて送ります。
// (Square の決済画面では住所を聞かないので、お客様の入力は1回で済みます)
//
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

const PREFECTURES = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];

// 日本の電話番号 → Square が求める国際形式 (+81...)
function toE164JP(phone) {
  const digits = clean(phone, 30).replace(/\D/g, '');
  return /^0\d{9,10}$/.test(digits) ? '+81' + digits.slice(1) : '';
}

// お届け先を確認して整えます。足りない項目があれば null
function normalizeCustomer(c) {
  if (!c || typeof c !== 'object') return null;
  const postalDigits = clean(c.postal, 20).replace(/\D/g, '');
  const n = {
    lastName: clean(c.lastName, 50),
    firstName: clean(c.firstName, 50),
    email: clean(c.email, 254),
    phoneRaw: clean(c.phone, 30),
    phone: toE164JP(c.phone),
    postal: /^\d{7}$/.test(postalDigits) ? `${postalDigits.slice(0, 3)}-${postalDigits.slice(3)}` : '',
    pref: PREFECTURES.includes(clean(c.pref, 10)) ? clean(c.pref, 10) : '',
    city: clean(c.city, 100),
    address1: clean(c.address1, 200),
    address2: clean(c.address2, 200),
  };
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(n.email);
  if (!n.lastName || !n.firstName || !emailOk || !n.phone || !n.postal || !n.pref || !n.city || !n.address1) {
    return null;
  }
  return n;
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

    const c = normalizeCustomer(customer);
    if (!c) {
      res.status(400).json({ error: 'お届け先の入力内容を確認してください' });
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
    const fullName = `${c.lastName} ${c.firstName}`;

    // 支払いに付けるメモ(どの方法で作成しても、Square の取引画面でお届け先が分かるように)
    const payment_note = [
      '【お届け先】',
      fullName,
      `〒${c.postal} ${c.pref}${c.city}${c.address1}${c.address2 ? ' ' + c.address2 : ''}`,
      `TEL ${c.phoneRaw}`,
      c.email,
    ].join('\n').slice(0, 500);

    // Square の注文に付ける「配送」情報
    const shipmentFulfillment = (prefValue) => ({
      type: 'SHIPMENT',
      state: 'PROPOSED',
      shipment_details: {
        recipient: {
          display_name: fullName,
          email_address: c.email,
          phone_number: c.phone,
          address: {
            postal_code: c.postal,
            administrative_district_level_1: prefValue,
            locality: c.city,
            address_line_1: c.address1,
            ...(c.address2 ? { address_line_2: c.address2 } : {}),
            country: 'JP',
          },
        },
      },
    });

    const shippingFeeOption = shippingAmount > 0
      ? { shipping_fee: { name: '送料', charge: { amount: shippingAmount, currency: 'JPY' } } }
      : {};

    const pre_populated_data = { buyer_email: c.email, buyer_phone_number: c.phone };

    // 作り方の候補。Square が受け付けなかったら次を試します。
    const prefCode = String(PREFECTURES.indexOf(c.pref) + 1).padStart(2, '0');
    const strategies = [
      {
        name: 'fulfillment(都道府県名)+送料',
        order: { fulfillments: [shipmentFulfillment(c.pref)] },
        checkout: shippingFeeOption,
      },
      {
        name: 'fulfillment(都道府県コード)+送料',
        order: { fulfillments: [shipmentFulfillment(prefCode)] },
        checkout: shippingFeeOption,
      },
      {
        name: 'メモのみ+送料',
        order: {},
        checkout: shippingFeeOption,
      },
      {
        name: 'メモのみ+送料(サービス料)',
        order: shippingAmount > 0 ? {
          service_charges: [{
            name: '送料',
            amount_money: { amount: shippingAmount, currency: 'JPY' },
            calculation_phase: 'TOTAL_PHASE',
          }],
        } : {},
        checkout: {},
      },
      {
        name: 'メモのみ+送料(商品の行)',
        order: {},
        checkout: {},
        extraLine: shippingAmount > 0,
      },
    ];

    let data = null;
    let response = null;
    let used = null;

    for (const s of strategies) {
      const orderLines = s.extraLine
        ? [...line_items, { name: '送料', quantity: '1', base_price_money: { amount: shippingAmount, currency: 'JPY' } }]
        : line_items;

      const body = {
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: process.env.SQUARE_LOCATION_ID,
          line_items: orderLines,
          ...s.order,
        },
        checkout_options: {
          // 住所はサイトで入力済みなので、Square の画面では聞きません
          ask_for_shipping_address: false,
          redirect_url: `${origin}/?checkout=success`,
          ...s.checkout,
        },
        pre_populated_data,
        payment_note,
      };

      response = await fetch(`${SQUARE_API_BASE}/v2/online-checkout/payment-links`, {
        method: 'POST',
        headers: squareHeaders(),
        body: JSON.stringify(body),
      });
      data = await response.json();

      if (response.ok) { used = s.name; break; }
      console.error(`payment link failed [${s.name}]`, JSON.stringify(data));
      // 400 以外(認証エラーなど)は、作り方を変えても直らないので打ち切り
      if (response.status !== 400) break;
    }

    if (!response || !response.ok) {
      const message = data && data.errors && data.errors[0] ? data.errors[0].detail : '決済セッションの作成に失敗しました';
      res.status(500).json({ error: message });
      return;
    }

    console.log(`payment link created [${used}]`);
    res.status(200).json({ url: data.payment_link.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '決済セッションの作成に失敗しました' });
  }
};
