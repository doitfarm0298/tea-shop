// Vercel Serverless Function
// URL: /api/create-checkout-session
//
// フロントエンド (index.html) から { items: [{variationId, quantity}, ...] } を受け取り、
// Square Checkout API (Payment Links) で決済ページを作成し、その URL を返します。
// アクセストークン (SQUARE_ACCESS_TOKEN) はここ(サーバー側)でのみ使用し、
// 絶対にフロントエンドのコードには書かないでください。
//
// 必要な環境変数:
//   SQUARE_ACCESS_TOKEN  … Square の アクセストークン(本番 or サンドボックス)
//   SQUARE_LOCATION_ID   … 決済を紐づける Square のロケーションID
//   SQUARE_ENV           … "sandbox" にするとテスト環境を使用(未設定なら本番)

const SQUARE_API_BASE = process.env.SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { items, shippingAmount } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'カートが空です' });
      return;
    }

    // フロントエンドのダミー ID (SQUARE_VARIATION_REPLACE_...) が
    // 残っている場合はここで弾きます。
    const invalid = items.find(i => !i.variationId || i.variationId.includes('REPLACE'));
    if (invalid) {
      res.status(400).json({
        error: 'Square の商品ID(バリエーションID)が設定されていない商品があります。index.html の PRODUCTS を確認してください。'
      });
      return;
    }

    const line_items = items.map(i => ({
      quantity: String(i.quantity),
      catalog_object_id: i.variationId,
    }));

    // 送料は商品カタログに存在しないため、金額指定のアドホックな行として追加します。
    // フロントエンド(index.html)の SHIPPING_FLAT / FREE_SHIPPING_MIN と
    // 計算ロジックを揃えてください。0円(送料無料)のときは行を追加しません。
    if (typeof shippingAmount === 'number' && shippingAmount > 0) {
      line_items.push({
        name: '送料',
        quantity: '1',
        base_price_money: { amount: shippingAmount, currency: 'JPY' },
      });
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;

    const response = await fetch(`${SQUARE_API_BASE}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2025-01-23',
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: process.env.SQUARE_LOCATION_ID,
          line_items,
        },
        checkout_options: {
          // 発送先の住所をお客様に入力してもらいます(配送に必要なため)。
          // 沖縄県・離島への追加送料は自動計算されないので、該当する場合は
          // 届いた注文を確認のうえ、別途ご連絡ください。
          ask_for_shipping_address: true,
          redirect_url: `${origin}/?checkout=success`,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(data);
      const message = data.errors && data.errors[0] ? data.errors[0].detail : '決済セッションの作成に失敗しました';
      res.status(500).json({ error: message });
      return;
    }

    res.status(200).json({ url: data.payment_link.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '決済セッションの作成に失敗しました' });
  }
};
