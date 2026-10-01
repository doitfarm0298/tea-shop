// Cloudflare Pages Function
// URL: /api/create-checkout-session
//
// フロントエンド (index.html) から
//   { items: [{variationId, quantity}, ...], customer: {...お届け先} }
// を受け取り、Square Checkout API (Payment Links) で決済ページを作成し、その URL を返します。
//
// お届け先はサイト側で入力してもらい、Square の注文データ(支払いメモ)に添えて送ります。
// (Square の決済画面では住所を聞かないので、お客様の入力は1回で済みます)
//
// アクセストークンはここ(サーバー側)でのみ使用し、絶対にフロントエンドのコードには書かないでください。
//
// Cloudflare Pages の「設定 → 変数とシークレット」に登録が必要なもの:
// SQUARE_ACCESS_TOKEN … Square のアクセストークン(本番 or サンドボックス)※「シークレット」で登録
// SQUARE_LOCATION_ID … 決済を紐づける Square のロケーションID
// SQUARE_ENV … "sandbox" にするとテスト環境を使用(それ以外・未設定なら本番)

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

const SQUARE_VERSION = '2025-01-23';

// 送料の設定
// index.html の SHIPPING_FLAT / FREE_SHIPPING_MIN と同じ値にしてください。
const SHIPPING_FLAT = 900;       // 通常の送料(円)
const FREE_SHIPPING_MIN = 8000;  // この金額(商品合計)以上で送料無料(円)

function squareHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
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

export async function onRequestPost({ request, env }) {
  const SQUARE_API_BASE = env.SQUARE_ENV === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';

  try {
    let payload = {};
    try { payload = await request.json(); } catch (e) { payload = {}; }
    const { items, customer } = payload || {};

    if (!Array.isArray(items) || items.length === 0) {
      return json({ error: 'カートが空です' }, 400);
    }

    const c = normalizeCustomer(customer);
    if (!c) {
      return json({ error: 'お届け先の入力内容を確認してください' }, 400);
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
      return json({ error: 'カートの内容に誤りがあります。ページを再読み込みしてやり直してください。' }, 400);
    }

    // Square から商品の価格を取得して、送料をサーバー側で計算します。
    // (ブラウザから送られた送料をそのまま使うと、書き換えられる恐れがあるため)
    const ids = [...new Set(cleanItems.map(i => i.variationId))];
    const catalogRes = await fetch(`${SQUARE_API_BASE}/v2/catalog/batch-retrieve`, {
      method: 'POST',
      headers: squareHeaders(env),
      body: JSON.stringify({ object_ids: ids }),
    });
    const catalogData = await catalogRes.json();

    if (!catalogRes.ok) {
      console.error(catalogData);
      return json({ error: '商品情報の取得に失敗しました' }, 500);
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
        return json({ error: '取り扱いのない商品がカートに含まれています。ページを再読み込みしてください。' }, 400);
      }
      subtotal += priceById[i.variationId] * i.quantity;
    }

    const shippingAmount = subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FLAT;

    const line_items = cleanItems.map(i => ({
      quantity: String(i.quantity),
      catalog_object_id: i.variationId,
    }));

    const origin = request.headers.get('origin') || new URL(request.url).origin;
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

    const contactPrefill = { buyer_email: c.email, buyer_phone_number: c.phone };
    // 連絡先の「姓・名」欄にも名前を入れる(Square の日本向け画面は first_name を「姓」の欄に出すため、
    // 姓 → first_name、名 → last_name の順で渡します)
    const contactPrefillWithName = {
      ...contactPrefill,
      buyer_address: { first_name: c.lastName, last_name: c.firstName, country: 'JP' },
    };

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

    // 名前の事前入力つき → なし の順に、各作り方を試します
    const attempts = [];
    strategies.forEach(st => {
      attempts.push({ ...st, prefill: contactPrefillWithName, label: st.name + '/名前あり' });
      attempts.push({ ...st, prefill: contactPrefill, label: st.name + '/名前なし' });
    });

    for (const s of attempts) {
      const orderLines = s.extraLine
        ? [...line_items, { name: '送料', quantity: '1', base_price_money: { amount: shippingAmount, currency: 'JPY' } }]
        : line_items;

      const body = {
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: env.SQUARE_LOCATION_ID,
          line_items: orderLines,
          ...s.order,
        },
        checkout_options: {
          // 住所はサイトで入力済みなので、Square の画面では聞きません
          ask_for_shipping_address: false,
          redirect_url: `${origin}/?checkout=success`,
          ...s.checkout,
        },
        pre_populated_data: s.prefill,
        payment_note,
      };

      response = await fetch(`${SQUARE_API_BASE}/v2/online-checkout/payment-links`, {
        method: 'POST',
        headers: squareHeaders(env),
        body: JSON.stringify(body),
      });
      data = await response.json();

      if (response.ok) { used = s.label; break; }
      console.error(`payment link failed [${s.label}]`, JSON.stringify(data));
      // 400 以外(認証エラーなど)は、作り方を変えても直らないので打ち切り
      if (response.status !== 400) break;
    }

    if (!response || !response.ok) {
      const message = data && data.errors && data.errors[0] ? data.errors[0].detail : '決済セッションの作成に失敗しました';
      return json({ error: message }, 500);
    }

    console.log(`payment link created [${used}]`);
    return json({ url: data.payment_link.url });
  } catch (err) {
    console.error(err);
    return json({ error: err.message || '決済セッションの作成に失敗しました' }, 500);
  }
}
