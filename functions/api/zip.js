// Cloudflare Pages Function
// URL: /api/zip?zipcode=6191111
//
// 郵便番号から住所を調べて返します。
// (日本郵便のデータを使った無料サービス zipcloud をサーバー側から呼び出します)

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
});

export async function onRequestGet({ request }) {
  const zip = (new URL(request.url).searchParams.get('zipcode') || '').replace(/\D/g, '');
  if (!/^\d{7}$/.test(zip)) {
    return json({ error: '郵便番号は7桁で入力してください' }, 400);
  }
  try {
    const r = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${zip}`);
    const data = await r.json();
    const hit = data && data.results && data.results[0];
    if (!hit) return json({ error: '住所が見つかりませんでした' }, 404);
    // 住所はほとんど変わらないので、1日キャッシュします
    return json({ pref: hit.address1, city: hit.address2, town: hit.address3 }, 200, { 'Cache-Control': 'public, max-age=86400' });
  } catch (err) {
    console.error(err);
    return json({ error: '住所の検索に失敗しました' }, 502);
  }
}
