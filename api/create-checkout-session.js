// Vercel Serverless Function
// URL: /api/create-checkout-session
//
// フロントエンド (index.html) から { items: [{variationId, quantity}, ...] } を受け取り、
// Square Checkout API (Payment Links) で決済ページを作成し、その URL を返します。
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { items } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'カートが空です' });
      return;
    }

    // 受け取った内容を整えてチェック
    const cleanItems = items.map(i => ({
