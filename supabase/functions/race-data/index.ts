import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// JRA場コード（netkeibaのrace_idも同じコード体系）
const VENUE_CODE: Record<string, string> = {
  "札幌": "01", "函館": "02", "福島": "03", "新潟": "04",
  "東京": "05", "中山": "06", "中京": "07", "京都": "08",
  "阪神": "09", "小倉": "10",
};

interface Horse {
  num: number; waku: number; name: string; jockey: string; horseId: string | null;
  p1: number | null; p2: number | null; p3: number | null; p4: number | null; p5: number | null;
  age3f: number | null; odds: number | null; ninki: number | null; sire: string | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "";
    const venue = url.searchParams.get("venue") || "東京";
    const date = url.searchParams.get("date") || "";       // YYYY-MM-DD
    const raceNum = parseInt(url.searchParams.get("race_num") || "1");

    if (action !== "kaisai" && !date) {
      return new Response(JSON.stringify({ error: "date は必須です (YYYY-MM-DD)" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const result = action === "kaisai" ? await fetchKaisaiDates()
      : action === "venues" ? await fetchVenues(date)
      : await fetchRaceData(venue, date, raceNum);

    return new Response(JSON.stringify(result), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});

// 今月＋来月の開催日一覧（netkeibaカレンダーから）
async function fetchKaisaiDates() {
  const now = new Date();
  const months: Array<[number, number]> = [[now.getFullYear(), now.getMonth() + 1]];
  months.push(now.getMonth() === 11 ? [now.getFullYear() + 1, 1] : [now.getFullYear(), now.getMonth() + 2]);

  const dates: Array<{ date: string; venues: string[]; graded: string[] }> = [];
  for (const [y, m] of months) {
    let cal: string;
    try {
      cal = await fetchHtml(`https://race.netkeiba.com/top/calendar.html?year=${y}&month=${m}`);
    } catch { continue; }
    for (const cell of cal.matchAll(/<a href="[^"]*kaisai_date=(\d{8})"[\s\S]*?<\/a>/g)) {
      const d = cell[1];
      const iso = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
      if (dates.some((x) => x.date === iso)) continue;
      dates.push({
        date: iso,
        venues: [...cell[0].matchAll(/class="JyoName">([^<]+)</g)].map((x) => x[1].trim()),
        graded: [...cell[0].matchAll(/class="JName">([^<]+)</g)].map((x) => x[1].trim()),
      });
    }
  }
  dates.sort((a, b) => a.date.localeCompare(b.date));
  return { dates };
}

// 指定日に開催中の競馬場と各場のメインレース
// グレード（G1>G2>G3>L>OP）付きレースを優先、なければ11R（JRAの慣例）
const GRADE_RANK: Record<number, number> = {1: 100, 2: 90, 3: 80, 15: 70, 5: 60};
const GRADE_LABEL: Record<number, string> = {1: "G1", 2: "G2", 3: "G3", 15: "L", 5: "OP"};

async function fetchVenues(date: string) {
  const d = date.replace(/-/g, "");
  const listHtml = await fetchHtml(`https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${d}`);
  const venues = [];
  for (const b of listHtml.split(/class="RaceList_DataTitle"/).slice(1)) {
    const header = b.slice(0, 200).replace(/<[^>]*>/g, " ");
    const vname = Object.keys(VENUE_CODE).find((v) => header.includes(v));
    if (!vname) continue;
    const races: Array<{ num: number; title: string; grade: number | null }> = [];
    const seen = new Set<number>();
    for (const it of b.split(/<li /).slice(1)) {
      const rid = it.match(/race_id=(\d{12})/)?.[1];
      if (!rid) continue;
      const num = parseInt(rid.slice(10, 12));
      if (seen.has(num)) continue;
      seen.add(num);
      const title = (it.match(/class="ItemTitle">([^<]+)</)?.[1] || "").trim();
      // グレードアイコンはレース名部分（RaceDataより手前）から取る
      const grade = parseInt(it.split('class="RaceData"')[0].match(/Icon_GradeType(\d+)/)?.[1] || "") || null;
      races.push({num, title, grade});
    }
    if (!races.length) continue;
    const main = races.filter((r) => r.grade !== null && GRADE_RANK[r.grade]).sort((a, b) => GRADE_RANK[b.grade!] - GRADE_RANK[a.grade!])[0]
      || races.find((r) => r.num === 11) || races[races.length - 1];
    venues.push({
      venue: vname,
      race_count: races.length,
      main_num: main.num,
      main_name: main.title,
      main_grade: (main.grade !== null && GRADE_LABEL[main.grade]) || null,
      main_rank: (main.grade !== null && GRADE_RANK[main.grade]) || 0,
    });
  }
  if (!venues.length) throw new Error(`${date} は開催がありません`);
  return { venues };
}

// netkeibaから出馬表・過去走・単勝オッズを取得
// （JRA公式はbot対策で非ブラウザからのアクセスを全面拒否するため）
async function fetchRaceData(venue: string, date: string, raceNum: number) {
  const d = date.replace(/-/g, "");
  const vc = VENUE_CODE[venue] || "05";

  // race_id = 西暦4桁 + 場コード2桁 + 開催回2桁 + 日目2桁 + レース番号2桁
  const listHtml = await fetchHtml(`https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${d}`);
  const ids = [...new Set([...listHtml.matchAll(/race_id=(\d{12})/g)].map((m) => m[1]))];
  const raceId = ids.find((id) => id.slice(4, 6) === vc && parseInt(id.slice(10, 12)) === raceNum);
  if (!raceId) {
    const venues = [...new Set(ids.map((id) => id.slice(4, 6)))]
      .map((c) => Object.keys(VENUE_CODE).find((k) => VENUE_CODE[k] === c) || c);
    throw new Error(`${venue}の開催が見つかりません（${date}）${venues.length ? " この日の開催: " + venues.join("・") : ""}`);
  }

  const [shutubaHtml, pastHtml, oddsJson] = await Promise.all([
    fetchHtml(`https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`),
    fetchHtml(`https://race.netkeiba.com/race/shutuba_past.html?race_id=${raceId}&rf=shutuba_submenu`).catch(() => ""),
    fetchHtml(`https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${raceId}&type=1`).catch(() => ""),
  ]);

  const horses = parseShutuba(shutubaHtml);
  if (!horses.length) throw new Error("出走馬データが取得できませんでした");
  mergePast(horses, pastHtml);
  mergeOdds(horses, oddsJson);

  const raceName = (shutubaHtml.match(/<title>([^|<]+?)\s*出馬表/)?.[1] || "").trim();
  return { horses, race_name: raceName, race_id: raceId };
}

// 出馬表：枠・馬番・馬名・騎手・馬ID
function parseShutuba(html: string): Horse[] {
  const horses: Horse[] = [];
  for (const m of html.matchAll(/<tr class="HorseList"[\s\S]*?<\/tr>/g)) {
    const r = m[0];
    // classの数字は枠色なので、馬番・枠番はtdの中身から取る
    const num = parseInt(r.match(/class="Umaban[^"]*"[^>]*>\s*(?:<div[^>]*>)?\s*(\d+)/)?.[1] || "");
    const waku = parseInt(r.match(/class="Waku\d*[^"]*"[^>]*>\s*(?:<span[^>]*>)?\s*(\d+)/)?.[1] || "");
    const name = (r.match(/class="HorseName"[\s\S]*?<a[^>]*title="([^"]+)"/)?.[1] ||
                  r.match(/class="HorseName"[\s\S]*?<a[^>]*>\s*([^<]+?)\s*</)?.[1] || "").trim();
    const horseId = r.match(/db\.netkeiba\.com\/horse\/(\d+)/)?.[1] || null;
    const jockey = (r.match(/class="Jockey"[\s\S]*?<a[^>]*>\s*([^<]+?)\s*</)?.[1] || "—").trim();
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
function mergePast(horses: Horse[], html: string) {
  if (!html) return;
  const byId: Record<string, { sire: string | null; past: Array<{ rank: number | null; agari: number | null }> }> = {};
  for (const m of html.matchAll(/<tr class="HorseList"[\s\S]*?<\/tr>/g)) {
    const r = m[0];
    const hid = r.match(/db\.netkeiba\.com\/horse\/(\d+)/)?.[1];
    if (!hid) continue;
    byId[hid] = {
      sire: (r.match(/class="Horse01[^"]*">([^<]+)</)?.[1] || "").trim() || null,
      past: [...r.matchAll(/<td class="Past[\s\S]*?(?=<td class="Past|<\/tr>)/g)].map((c) => ({
        rank: parseInt(c[0].match(/class="Num">(\d+)</)?.[1] || "") || null,
        agari: parseFloat(c[0].match(/\((\d{2}\.\d)\)/)?.[1] || "") || null,
      })),
    };
  }
  for (const h of horses) {
    const info = h.horseId ? byId[h.horseId] : undefined;
    if (!info) continue;
    h.sire = info.sire;
    [h.p1, h.p2, h.p3, h.p4, h.p5] = [0, 1, 2, 3, 4].map((i) => info.past[i]?.rank ?? null);
    h.age3f = info.past[0]?.agari ?? null;
  }
}

// 単勝オッズAPI：{data:{odds:{"1":{"01":["7.4","0.0","5"],...}}}}（発売前は空）
function mergeOdds(horses: Horse[], jsonText: string) {
  try {
    const tan = JSON.parse(jsonText)?.data?.odds?.["1"];
    if (!tan) return;
    for (const h of horses) {
      const e = tan[String(h.num).padStart(2, "0")];
      if (!e) continue;
      h.odds = parseFloat(e[0]) || null;
      h.ninki = parseInt(e[2]) || null;
    }
  } catch { /* 発売前・API変更時はオッズなしで続行 */ }
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja,en;q=0.9",
      "Referer": "https://race.netkeiba.com/",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const buf = await res.arrayBuffer();
  return decodeHtml(buf, res.headers.get("content-type"));
}

// Content-Typeヘッダ→HTML内metaタグの順でcharsetを判定してデコード
function decodeHtml(buf: ArrayBuffer, contentType: string | null): string {
  let charset = contentType?.match(/charset=([\w-]+)/i)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 2048));
    charset = head.match(/charset=["']?([\w-]+)/i)?.[1];
  }
  for (const cs of [charset || "utf-8", "utf-8", "shift_jis", "euc-jp"]) {
    try {
      return new TextDecoder(cs.toLowerCase()).decode(buf);
    } catch { /* 未対応のcharsetラベルなら次を試す */ }
  }
  return new TextDecoder("utf-8").decode(buf);
}
