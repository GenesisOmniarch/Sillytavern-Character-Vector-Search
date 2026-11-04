# Character Vector Search (SillyTavern 拡張機能)

標準の **Vector Storage** 拡張による Data Bank 検索(直近のチャット文をクエリにする)に**加えて**、
**キャラクターカード全体**をクエリにして Data Bank をベクトル検索し、関連するチャンクをプロンプトに挿入します。

## 特徴

- **1対1チャット**: 応答キャラクターのカード全体で検索
- **グループチャット**: 毎回の生成で、**メンバー全員分**(人数分)をそれぞれのカードで検索
  - **挿入は応答キャラ自身の結果だけ**(デフォルト)。Alice の応答には Alice のカードで検索した結果だけ、
    Bob の応答には Bob の結果だけが入るので、キャラ同士の口調や設定が混ざりません
  - 全員分の検索結果はキャッシュされ、各メンバーの番で再利用されます
  - 設定で「全員分をまとめて挿入」や「検索は応答キャラのみ」にも切り替え可能
  - ミュート中のメンバーを含めるかどうかも設定可能(デフォルト: 含める)
- **Retrieve chunks / Score threshold は標準 Vector Storage 拡張と同じ値**を使用
  (Vector Storage 設定の Data Bank「Retrieve chunks」と「Score threshold」を毎回読み込みます)
- Embedding ソース・モデル、チャンク分割設定も Vector Storage 拡張の設定をそのまま使用
- Data Bank ファイルのベクトルインデックス(`file_<hash>`)は標準拡張と共有。
  まだベクトル化されていないファイル(例: 他のグループメンバーの Character 添付)は同じ設定で自動的に取り込みます
- キャラごとに検索範囲を分離: `Global + Chat + そのキャラ自身の Character 添付`
  (設定で「対象キャラ全員の Character 添付」にも変更可)
- 検索結果のキャッシュ: カード内容が変わらない限り再 Embedding しないので、グループで人数分検索しても毎ターンのコストは増えません

## インストール

SillyTavern の **Extensions → Install extension** に以下の URL を入力します。

```
https://github.com/GenesisOmniarch/Sillytavern-Character-Vector-Search
```

## 使い方

1. 標準の **Vector Storage** 拡張で Embedding ソース(Vectorization Source)を設定します。
   Data Bank の「Retrieve chunks」「Score threshold」もここで設定した値が使われます。
   (標準拡張の「Enabled for files」がオフでも、この拡張は単独で動作します)
2. Data Bank(📎 → Open Data Bank)にファイルを追加します。
3. Extensions パネルの **Character Vector Search** を開き、「有効化」をオンにします。
4. 「テスト検索」ボタンで、現在のチャットで何が挿入されるかを確認できます。

## 設定項目

| 項目 | 説明 |
| --- | --- |
| 挿入する結果(グループ) | 応答キャラ自身の結果のみ(推奨・デフォルト)/ 全員分をまとめて挿入 |
| 検索対象(グループ) | グループ全員分 / 応答キャラクターのみ |
| ミュート中のメンバーも含める | グループ全員分モード時 |
| 検索する Data Bank の範囲 | そのキャラ自身の Character 添付のみ / 対象キャラ全員分 |
| クエリに使うカードの項目 | Name, Description, Personality, Scenario, First message, Examples, System prompt, Post-history, Character's note などを選択 |
| クエリ最大文字数 | Embedding モデルの入力上限を超える場合に設定(0 = 無制限) |
| Injection Template | 標準拡張の Data Bank「Injection Template」と同じ。`{{text}}` の位置に応答キャラの検索結果が入ります(まとめて挿入時は全員分)。`{{name}}` = 応答キャラ名。`{{char}}` などのマクロも使用可 |
| Per-character Template | キャラごとの結果の書式。`{{name}}` = キャラ名、`{{text}}` = そのキャラの結果 |
| Injection Position | 標準拡張と同じ(Before / After Main Prompt、In-chat @ Depth as System/User/Assistant) |
| 重複チャンクを1回だけ挿入 | 複数キャラで同じチャンクがヒットした場合 |
| キャッシュ | 検索結果をメモリにキャッシュ |

## 注意

- カード全体が長い場合、Embedding モデルによっては入力上限を超えてエラーになったり、
  末尾が切り捨てられたりします。その場合は「クエリ最大文字数」を設定するか、使用する項目を減らしてください。
- 標準拡張で「Purge Vectors」などを行った後は「キャッシュクリア」を押してください。
- 標準拡張で挿入されるチャンクと同じ内容がこの拡張でも挿入されることがあります(別枠での挿入です)。
