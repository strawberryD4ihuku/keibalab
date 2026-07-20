# JRA-VAN（JV-Link）取り込みパイプライン

JV-Link の蓄積系データ（RACE）から `verify_results` 用の検証行を作り、Supabase に投入する。
2000年（実際は1999年12月）以降の全レースを対象にできる。

## 全体の流れ

```
JV-Link ──jv-fetch.ps1──▶ jvdata2000/{RA,SE,HR}.txt
                              │
                       jv-import.js（index.html のスコアリングを実行時抽出）
                              │
                              ▼
                     jvdata2000/verify_rows.json
                              │
                        jv-upload.ps1（Supabase REST）
                              │
                              ▼
                   public.verify_results（フロントの「おいしい買い方さがし」が読む）
```

## 1. 取得：`jv-fetch.ps1`

```
# 必ず 32bit PowerShell（JVLink は 32bit COM）
C:\WINDOWS\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -File tools\jv-fetch.ps1 `
  -From 19990101000000 -OutDir C:\work\keibaLab\jvdata2000 -Option 4
```

- Option: `1`=通常差分 / `4`=セットアップ（全期間。初回はダイアログ承認が要る）。
- 出力: `<OutDir>\{RA,SE,HR}.txt`（1行=1レコード・UTF-8）、`status.txt`（進捗）。
- `-DataSpec` でデータ種別を変えられる（既定 `RACE`）。坂路調教は
  `-DataSpec SLOP -Types HC`、ウッド調教は `-DataSpec WOOD -Types WC`（出力先は `jvtrain\` を使う）。
- `-Append` で既存の種別ファイルへ追記する（差分取得用）。調教データの最新化は
  レース当日朝に `-From <前回取得日時> -OutDir C:\work\keibaLab\jvtrain -DataSpec SLOP -Types HC -Append`。
  重複行が混ざっても特徴量側（`lib/training-features.js`）で除去される。
- 分析に不要な種別（O1-O6=オッズ, H1/H6=票数, JG=障害飛越, WF=重勝）はファイルごと `JVSkip` で読み飛ばす。
- 生ファイル(.jvd)は `jvcache\` に保存される（`JVSetSaveFlag`）。

> **所要時間の注意**：`Option 4`（セットアップ）の JVRead は JV-Link が難読化アーカイブを
> レコード単位で復号するため **約30件/秒** と遅い。直近データ（JV-Link の復号済みストア）は
> 桁違いに速いが、過去に遡るほどこの上限に張り付く。2000年以降の全期間（RA/SE/HR で数百万件）は
> **バックグラウンドで丸一日規模**かかる。速く済ませたい場合は `-From` を近年（例 `20150101000000`）に。
>
> 補足：`jvcache\` の生 .jvd は JV-Link 独自方式で難読化されており（種別ごと・かつ年代ごとに
> 別の置換テーブル）、平文が手元にない過去データを直接復号することはできない。取得は必ず JVRead 経由で行う。
> （遅延バインドの C# ホストも試したが、JVRead の ByRef 文字列バッファが書き戻らず断念。）

## 2. 変換：`jv-import.js`

```
node tools/jv-import.js --dir jvdata2000 --out jvdata2000/verify_rows.json
```

- `index.html` から `computeScore` などのスコアリングを実行時に抽出して使う
  （フロントと完全に同一ロジックを保証）。
- `--train-dir`（既定 `jvtrain`）に `HC.txt` があれば坂路調教特徴量（train*）を付与する。
  `proxy.js` も同じファイルの直近120日分を読んでライブ出馬表に同一特徴量を付ける。
- 馬柱軸のスコアで当時の予想を再現。戦績集計はレース当日より前のデータのみ（リーク防止）。
- 出力の各行に分析用フィールドを含む: `surface, distance, baba(馬場状態), race_class(クラス),
  field(頭数), axis_odds, axis_ninki, score_gap, per_bet(券種別損益)`。

## 3. 投入：`jv-upload.ps1`

```
powershell -File tools\jv-upload.ps1 -RowsFile jvdata2000\verify_rows.json
```

- 実行時に `verify_results` へ `baba` `race_class` カラムを追加（冪等）。
- 既存の特徴量なし行（`axis_odds is null`）と馬場状態なし行だけ上書きし、それ以外は保持。
- 認証は Supabase CLI の管理トークン（Windows 資格情報マネージャー）を使用。

## フロント側（index.html「検証」ページ）

- **おいしい買い方さがし**：ためた `verify_results` を「条件×券種」で総当り集計。
  条件軸は オッズ帯／頭数／馬場／自信度／場／距離帯／クラス／馬場状態／季節 の9種。
  対象期間（全期間〜直近1年）で絞れる。
- **⭐使う**：良かった条件を localStorage に保存 → 予想ページで出馬表を取得したとき、
  そのレースが条件に合致すると「データ分析の狙い目」カードに推奨買い目を自動表示。
