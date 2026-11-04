# Character Vector Search (SillyTavern 拡張機能)

標準の **Vector Storage** 拡張による Data Bank 検索(直近のチャット文をクエリにする)に**加えて**、
**キャラクターカード全体**をクエリにして Data Bank をベクトル検索し、関連するチャンクをプロンプトに挿入します。

## 特徴

- **1対1チャット**: 応答キャラクターのカード全体で検索
- **グループチャット**: 毎回の生成で、**メンバー全員分**(人数分)をそれぞれのカードで検索し、
  **全員分の参考資料を毎回挿入**します。誰が応答する番でも全キャラの資料がプロンプトにあるため、
  全員の口調が途切れず、全員が会話に参加し続けられます
  - `{{text}}` には全員分が入り、**キャラごとに明確なブロックで区切られます**(AI がどのキャラの資料か混同しないため):

    ```
    <character_reference name="Alice">
    (Alice のカードで検索したチャンク)
    </character_reference>

    <character_reference name="Bob">
    (Bob のカードで検索したチャンク)
    </character_reference>
    ```
  - ブロックは拡張機能が作るので、Injection Template の内容に関係なく区切りは保たれます
  - キャラ間でチャンクの重複除去は行いません(各キャラが自分の資料を欠けずに持ちます)
  - ミュート中のメンバーを含めるかどうかも設定可能(デフォルト: 含める)
- **Retrieve chunks / Score threshold は標準 Vector Storage 拡張と同じ値**を使用
  (Vector Storage 設定の Data Bank「Retrieve chunks」と「Score threshold」を毎回読み込みます)
- Embedding ソース・モデル、チャンク分割設定も Vector Storage 拡張の設定をそのまま使用
- **この拡張は Data Bank ファイルのベクトル化を一切行いません。** 標準 Vector Storage 拡張がベクトル化して保存したもの(`file_<hash>`)だけを検索します。
  まだベクトル化されていないファイルは結果が0件になるだけです(Vector Storage でベクトル化すると自動的に対象になります)
- **既存のベクトルを書き換え・削除する可能性のある処理は一切行いません。** サーバーへ送るのは検索(`/api/vector/query-multi`)だけで、
  これは保存済みのベクトルを読むだけの窓口です。`/api/vector/list` など、index.json の読み込みに失敗すると
  SillyTavern 本体がそのコレクションを削除して作り直す窓口は使いません
- 毎回の検索で Embedding API が呼ばれるのはクエリ(キャラカード)側だけで、これは標準拡張がチャット文をクエリにする場合と同じです。
  カードが変わらない限り結果をキャッシュするので、通常は2ターン目以降は呼ばれません。同じファイルへの同時アクセスを避けるため、キャラごとの検索は1件ずつ順番に行います
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
   検索したい Data Bank ファイルは、Vector Storage でベクトル化しておいてください(この拡張はベクトル化しません)。
   グループの場合、他メンバーの Character 添付は、そのキャラを選んだ状態で Vector Storage の「Vectorize All」を実行するとベクトル化されます
2. Data Bank(📎 → Open Data Bank)にファイルを追加します。
3. Extensions パネルの **Character Vector Search** を開き、「有効化」をオンにします。
4. 「テスト検索」ボタンで、現在のチャットで何が挿入されるかを確認できます。

## 設定項目

| 項目 | 説明 |
| --- | --- |
| ミュート中のメンバーも含める | グループ全員分モード時 |
| 検索する Data Bank の範囲 | そのキャラ自身の Character 添付のみ / 対象キャラ全員分 |
| クエリに使うカードの項目 | Name, Description, Personality, Scenario, First message, Examples, System prompt, Post-history, Character's note などを選択 |
| クエリ最大文字数 | Embedding モデルの入力上限を超える場合に設定(0 = 無制限) |
| Injection Template | 標準拡張の Data Bank「Injection Template」と同じく自由に記述でき、1回だけ適用されます。`{{text}}` = 全員分の検索結果(キャラごとのブロックに区切り済み)。`{{text}}` を書かなかった場合は末尾に付き、空の場合はブロックのみ挿入。`{{char}}` などのマクロは通常どおり展開されます。資料本文中の `{{char}}` は各ブロックの持ち主の名前で展開されます |
| Injection Position | 標準拡張と同じ(Before / After Main Prompt、In-chat @ Depth as System/User/Assistant) |
| キャッシュ | 検索結果をメモリにキャッシュ |

## 注意

- カード全体が長い場合、Embedding モデルによっては入力上限を超えてエラーになったり、
  末尾が切り捨てられたりします。その場合は「クエリ最大文字数」を設定するか、使用する項目を減らしてください。
- 標準拡張で「Purge Vectors」などを行った後は「キャッシュクリア」を押してください。
- 標準拡張で挿入されるチャンクと同じ内容がこの拡張でも挿入されることがあります(別枠での挿入です)。
