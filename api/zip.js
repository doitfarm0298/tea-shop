// Vercel Serverless Function
// URL: /api/zip?zipcode=6191111
//
// 郵便番号から住所を調べて返します。
// (日本郵便のデータを使った無料サービス zipcloud をサーバー側から呼び出します)

module.exports = async (req, res) => {
  const zip = String((req.query && req.query.zipcode) || '').replace(/\D/g, '');
  if (!/^\d{7}$/.test(zip)) {
    res.status(400).json({ error: '郵便番号は7桁で入力してください' });
    return;
  }

  try {
    const r = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${zip}`);
    const data = await r.json();
    const hit = data && data.results && data.results[0];
    if (!hit) {
      res.status(404).json({ error: '住所が見つかりませんでした' });
      return;
    }
    // 住所はほとんど変わらないので、1日キャッシュします
    res.setHeader('Cache-Control', 's-maxage=86400');
    res.status(200).json({ pref: hit.address1, city: hit.address2, town: hit.address3 });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: '住所の検索に失敗しました' });
  }
};
