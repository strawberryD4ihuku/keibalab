const http = require('http');
const https = require('https');

const PORT = 3001;

const VENUE_CODE = {
  '札幌':'01','函館':'02','福島':'03','新潟':'04',
  '東京':'05','中山':'06','中京':'07','京都':'08',
  '阪神':'09','小倉':'10',
};

const fs = require('fs');
const path = require('path');

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // index.htmlを配信
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(html);
    return;
  }

  if (url.pathname !== '/race-data') { res.writeHead(404); res.end('Not found'); return; }

  const action = url.searchParams.get('action') || '';
  const venue = url.searchParams.get('venue') || '東京';
  const date = url.searchParams.get('date') || '';
  const raceNum = parseInt(url.searchParams.get('race_num') || '1');

  try {
    let result;
    if (action === 'kaisai') {
      result = await fetchKaisaiDates();
    } else if (action === 'venues') {
      if (!date) throw Object.assign(new Error('date は必須です'), {status: 400});
      result = await fetchVenues(date);
    } else {
      if (!date) throw Object.assign(new Error('date は必須です'), {status: 400});
      result = await fetchRaceData(venue, date, raceNum);
    }
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(e.status || 500, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ error: e.message }));
  }
});

// 今月＋来月の開催日一覧（netkeibaカレンダーから）
async function fetchKaisaiDates() {
  const now = new Date();
  const months = [[now.getFullYear(), now.getMonth() + 1]];
  months.push(now.getMonth() === 11 ? [now.getFullYear() + 1, 1] : [now.getFullYear(), now.getMonth() + 2]);

  const dates = [];
  for (const [y, m] of months) {
    let cal;
    try {
      cal = await fetchHtml(`https://race.netkeiba.com/top/calendar.html?year=${y}&month=${m}`);
    } catch { continue; }
    for (const cell of cal.matchAll(/<a href="[^"]*kaisai_date=(\d{8})"[\s\S]*?<\/a>/g)) {
      const d = cell[1];
      const iso = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
      if (dates.some(x => x.date === iso)) continue;
      dates.push({
        date: iso,
        venues: [...cell[0].matchAll(/class="JyoName">([^<]+)</g)].map(x => x[1].trim()),
        graded: [...cell[0].matchAll(/class="JName">([^<]+)</g)].map(x => x[1].trim()),
      });
    }
  }
  dates.sort((a, b) => a.date.localeCompare(b.date));
  return { dates };
}

// 指定日に開催中の競馬場と各場のメインレース
// グレード（G1>G2>G3>L>OP）付きレースを優先、なければ11R（JRAの慣例）
const GRADE_RANK = {1: 100, 2: 90, 3: 80, 15: 70, 5: 60};
const GRADE_LABEL = {1: 'G1', 2: 'G2', 3: 'G3', 15: 'L', 5: 'OP'};

async function fetchVenues(date) {
  const d = date.replace(/-/g, '');
  const listHtml = await fetchHtml(`https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${d}`);
  const venues = [];
  for (const b of listHtml.split(/class="RaceList_DataTitle"/).slice(1)) {
    const header = b.slice(0, 200).replace(/<[^>]*>/g, ' ');
    const vname = Object.keys(VENUE_CODE).find(v => header.includes(v));
    if (!vname) continue;
    const races = [];
    const seen = new Set();
    for (const it of b.split(/<li /).slice(1)) {
      const rid = it.match(/race_id=(\d{12})/)?.[1];
      if (!rid) continue;
      const num = parseInt(rid.slice(10, 12));
      if (seen.has(num)) continue;
      seen.add(num);
      const title = (it.match(/class="ItemTitle">([^<]+)</)?.[1] || '').trim();
      // グレードアイコンはレース名部分（RaceDataより手前）から取る
      const grade = parseInt(it.split('class="RaceData"')[0].match(/Icon_GradeType(\d+)/)?.[1] || '') || null;
      races.push({num, title, grade});
    }
    if (!races.length) continue;
    const main = races.filter(r => GRADE_RANK[r.grade]).sort((a, b) => GRADE_RANK[b.grade] - GRADE_RANK[a.grade])[0]
      || races.find(r => r.num === 11) || races[races.length - 1];
    venues.push({
      venue: vname,
      race_count: races.length,
      main_num: main.num,
      main_name: main.title,
      main_grade: GRADE_LABEL[main.grade] || null,
      main_rank: GRADE_RANK[main.grade] || 0,
    });
  }
  if (!venues.length) throw new Error(`${date} は開催がありません`);
  return { venues };
}

// netkeibaから出馬表・過去走・単勝オッズを取得
// （JRA公式はbot対策で非ブラウザからのアクセスを全面拒否するため）
async function fetchRaceData(venue, date, raceNum) {
  const d = date.replace(/-/g, '');
  const vc = VENUE_CODE[venue] || '05';

  // race_id = 西暦4桁 + 場コード2桁 + 開催回2桁 + 日目2桁 + レース番号2桁
  const listHtml = await fetchHtml(`https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${d}`);
  const ids = [...new Set([...listHtml.matchAll(/race_id=(\d{12})/g)].map(m => m[1]))];
  const raceId = ids.find(id => id.slice(4, 6) === vc && parseInt(id.slice(10, 12)) === raceNum);
  if (!raceId) {
    const venues = [...new Set(ids.map(id => id.slice(4, 6)))]
      .map(c => Object.keys(VENUE_CODE).find(k => VENUE_CODE[k] === c) || c);
    throw new Error(`${venue}の開催が見つかりません（${date}）${venues.length ? ' この日の開催: ' + venues.join('・') : ''}`);
  }

  const [shutubaHtml, pastHtml, oddsJson] = await Promise.all([
    fetchHtml(`https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`),
    fetchHtml(`https://race.netkeiba.com/race/shutuba_past.html?race_id=${raceId}&rf=shutuba_submenu`).catch(() => ''),
    fetchHtml(`https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${raceId}&type=1`).catch(() => ''),
  ]);

  const horses = parseShutuba(shutubaHtml);
  if (!horses.length) throw new Error('出走馬データが取得できませんでした');
  mergePast(horses, pastHtml);
  mergeOdds(horses, oddsJson);

  const raceName = (shutubaHtml.match(/<title>([^|<]+?)\s*出馬表/)?.[1] || '').trim();
  return { horses, race_name: raceName, race_id: raceId };
}

// 出馬表：枠・馬番・馬名・騎手・馬ID
function parseShutuba(html) {
  const horses = [];
  for (const m of html.matchAll(/<tr class="HorseList"[\s\S]*?<\/tr>/g)) {
    const r = m[0];
    // classの数字は枠色なので、馬番・枠番はtdの中身から取る
    const num = parseInt(r.match(/class="Umaban[^"]*"[^>]*>\s*(?:<div[^>]*>)?\s*(\d+)/)?.[1] || '');
    const waku = parseInt(r.match(/class="Waku\d*[^"]*"[^>]*>\s*(?:<span[^>]*>)?\s*(\d+)/)?.[1] || '');
    const name = (r.match(/class="HorseName"[\s\S]*?<a[^>]*title="([^"]+)"/)?.[1] ||
                  r.match(/class="HorseName"[\s\S]*?<a[^>]*>\s*([^<]+?)\s*</)?.[1] || '').trim();
    const horseId = r.match(/db\.netkeiba\.com\/horse\/(\d+)/)?.[1] || null;
    const jockey = (r.match(/class="Jockey"[\s\S]*?<a[^>]*>\s*([^<]+?)\s*</)?.[1] || '—').trim();
    if (!num || !name) continue;
    horses.push({
      num, waku: waku || Math.ceil(num / 2), name, jockey, horseId,
      p1: null, p2: null, p3: null, p4: null, p5: null,
      age3f: null, odds: null, ninki: null, sire: null,
    });
  }
  return horses;
}

// 過去走ページ：直近5走の着順・前走の上がり3F・父（産駒）を馬IDで結合
function mergePast(horses, html) {
  if (!html) return;
  const byId = {};
  for (const m of html.matchAll(/<tr class="HorseList"[\s\S]*?<\/tr>/g)) {
    const r = m[0];
    const hid = r.match(/db\.netkeiba\.com\/horse\/(\d+)/)?.[1];
    if (!hid) continue;
    byId[hid] = {
      sire: (r.match(/class="Horse01[^"]*">([^<]+)</)?.[1] || '').trim() || null,
      past: [...r.matchAll(/<td class="Past[\s\S]*?(?=<td class="Past|<\/tr>)/g)].map(c => ({
        rank: parseInt(c[0].match(/class="Num">(\d+)</)?.[1] || '') || null,
        agari: parseFloat(c[0].match(/\((\d{2}\.\d)\)/)?.[1] || '') || null,
      })),
    };
  }
  for (const h of horses) {
    const info = h.horseId && byId[h.horseId];
    if (!info) continue;
    h.sire = info.sire;
    [h.p1, h.p2, h.p3, h.p4, h.p5] = [0, 1, 2, 3, 4].map(i => info.past[i]?.rank ?? null);
    h.age3f = info.past[0]?.agari ?? null;
  }
}

// 単勝オッズAPI：{data:{odds:{"1":{"01":["7.4","0.0","5"],...}}}}（発売前は空）
function mergeOdds(horses, jsonText) {
  try {
    const tan = JSON.parse(jsonText)?.data?.odds?.['1'];
    if (!tan) return;
    for (const h of horses) {
      const e = tan[String(h.num).padStart(2, '0')];
      if (!e) continue;
      h.odds = parseFloat(e[0]) || null;
      h.ninki = parseInt(e[2]) || null;
    }
  } catch { /* 発売前・API変更時はオッズなしで続行 */ }
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
        'Referer': 'https://race.netkeiba.com/',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve(decodeHtml(Buffer.concat(chunks), res.headers['content-type']));
      });
    });
    req.on('error', reject);
  });
}

// Content-Typeヘッダ→HTML内metaタグの順でcharsetを判定してデコード
// （JRA公式はShift_JISなのでフォールバックもShift_JIS）
function decodeHtml(buf, contentType) {
  const iconv = require('iconv-lite');
  let charset = contentType && /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = buf.slice(0, 2048).toString('latin1');
    charset = /charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  charset = (charset || 'shift_jis').toLowerCase().replace('shift-jis', 'shift_jis');
  if (!iconv.encodingExists(charset)) charset = 'shift_jis';
  return iconv.decode(buf, charset);
}

server.listen(PORT, () => {
  console.log(`✅ KeibaLab プロキシ起動中: http://localhost:${PORT}`);
  console.log('   停止するには Ctrl+C');
});
