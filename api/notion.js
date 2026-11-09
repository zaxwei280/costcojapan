// Vercel Serverless Function — 日本好市多 商品照片管理 Notion Proxy
// 環境變數：
//   NOTION_TOKEN            Notion Integration 密鑰
//   NOTION_DB_ID            資料庫 ID
//   CLOUDINARY_CLOUD_NAME   Cloudinary cloud name
//   CLOUDINARY_API_KEY      Cloudinary API Key
//   CLOUDINARY_API_SECRET   Cloudinary API Secret
//   CLOUDINARY_FOLDER       （選填）存放資料夾，預設 costco

const crypto = require('crypto');

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Notion 欄位名稱（如果你的資料庫欄位名稱不同，只要改這裡）
const P = {
  name: '商品名稱',   // Title
  code: '商品編號',   // Text
  cat: '分類',        // Select
  barcode: '條碼',    // Text
  price: '現場價錢',  // Number
  sale: '現場特價',   // Number
  photos: '照片',     // Text（多張網址用 , 分隔）
  date: '更新日期'    // Date
};

async function notion(path, method = 'GET', body) {
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + process.env.NOTION_TOKEN,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || ('Notion 錯誤 ' + r.status));
  return j;
}

function txt(arr) {
  return (arr || []).map(t => t.plain_text).join('');
}

// Notion 單段文字上限 2000 字，超過就切成多段
function rich(v) {
  const s = v == null ? '' : String(v);
  const out = [];
  for (let i = 0; i < s.length && out.length < 100; i += 2000) {
    out.push({ text: { content: s.slice(i, i + 2000) } });
  }
  return out;
}

function splitUrls(s) {
  return String(s || '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
}

function simplify(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    name: txt(p[P.name] && p[P.name].title),
    code: txt(p[P.code] && p[P.code].rich_text),
    cat: (p[P.cat] && p[P.cat].select && p[P.cat].select.name) || '',
    barcode: txt(p[P.barcode] && p[P.barcode].rich_text),
    price: p[P.price] && p[P.price].number != null ? p[P.price].number : null,
    sale: p[P.sale] && p[P.sale].number != null ? p[P.sale].number : null,
    photos: splitUrls(txt(p[P.photos] && p[P.photos].rich_text)),
    date: (p[P.date] && p[P.date].date && p[P.date].date.start) || '',
    edited: page.last_edited_time
  };
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function buildProps(d) {
  const props = {};
  if (!d) return props;
  if ('name' in d) props[P.name] = { title: rich(d.name) };
  if ('code' in d) props[P.code] = { rich_text: rich(d.code) };
  if ('cat' in d) props[P.cat] = { select: d.cat ? { name: String(d.cat).replace(/,/g, '，').slice(0, 100) } : null };
  if ('barcode' in d) props[P.barcode] = { rich_text: rich(d.barcode) };
  if ('price' in d) props[P.price] = { number: numOrNull(d.price) };
  if ('sale' in d) props[P.sale] = { number: numOrNull(d.sale) };
  if ('date' in d) props[P.date] = { date: d.date ? { start: String(d.date).slice(0, 10) } : null };
  if ('photos' in d) {
    const list = Array.isArray(d.photos) ? d.photos : splitUrls(d.photos);
    props[P.photos] = { rich_text: rich(list.join(',')) };
  }
  return props;
}

// 簽名上傳到 Cloudinary（API Secret 只存在伺服器端）
async function uploadCloudinary(base64, contentType) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const key = process.env.CLOUDINARY_API_KEY;
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!cloud || !key || !secret) throw new Error('缺少 Cloudinary 環境變數');

  const folder = process.env.CLOUDINARY_FOLDER || 'costco';
  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = 'folder=' + folder + '&timestamp=' + timestamp + secret;
  const signature = crypto.createHash('sha1').update(toSign).digest('hex');

  const form = new FormData();
  form.append('file', 'data:' + (contentType || 'image/jpeg') + ';base64,' + base64);
  form.append('api_key', key);
  form.append('timestamp', String(timestamp));
  form.append('folder', folder);
  form.append('signature', signature);

  const r = await fetch('https://api.cloudinary.com/v1_1/' + cloud + '/image/upload', { method: 'POST', body: form });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Cloudinary 上傳失敗');
  return j.secure_url;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: '只接受 POST' });
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DB_ID) {
    return res.status(500).json({ error: '缺少環境變數 NOTION_TOKEN 或 NOTION_DB_ID' });
  }
  const DB = process.env.NOTION_DB_ID;
  const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) || {};

  try {
    switch (b.action) {
      case 'schema': {
        const db = await notion('/databases/' + DB);
        const sel = db.properties[P.cat] && db.properties[P.cat].select;
        return res.json({ categories: sel ? sel.options.map(o => o.name) : [] });
      }

      case 'list': {
        let results = [];
        let cursor;
        do {
          const q = await notion('/databases/' + DB + '/query', 'POST', {
            page_size: 100,
            start_cursor: cursor,
            sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
          });
          results = results.concat(q.results);
          cursor = q.has_more ? q.next_cursor : undefined;
        } while (cursor);
        return res.json({ items: results.map(simplify) });
      }

      case 'upload': {
        if (!b.data) return res.status(400).json({ error: '沒有照片資料' });
        const url = await uploadCloudinary(b.data, b.contentType);
        return res.json({ url });
      }

      case 'create': {
        const page = await notion('/pages', 'POST', { parent: { database_id: DB }, properties: buildProps(b.data) });
        return res.json({ item: simplify(page) });
      }

      case 'update': {
        if (!b.pageId) return res.status(400).json({ error: '缺少 pageId' });
        const page = await notion('/pages/' + b.pageId, 'PATCH', { properties: buildProps(b.data) });
        return res.json({ item: simplify(page) });
      }

      case 'archive': {
        if (!b.pageId) return res.status(400).json({ error: '缺少 pageId' });
        await notion('/pages/' + b.pageId, 'PATCH', { archived: true });
        return res.json({ ok: true });
      }

      default:
        return res.status(400).json({ error: '未知的 action' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
