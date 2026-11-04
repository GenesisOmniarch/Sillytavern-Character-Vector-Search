// Data Bank ベクトル診断スクリプト(読み取り専用・Embedding API は呼びません)
//
// 使い方: SillyTavern を開いた状態でブラウザの開発者ツール(F12)→ Console に全文を貼り付けて Enter。
// 実行前に必ず SillyTavern の data/<ユーザー名>/vectors フォルダをバックアップしてください。
// (index.json が壊れているコレクションは、SillyTavern 本体の仕様で読み込み時に自動削除されるため)
//
// 各 Data Bank ファイルについて、Vector Storage の設定で分割した場合のチャンク数と、
// 保存済みベクトルのチャンク数を比較し、欠けているファイルを表示します。
(async () => {
    const { extension_settings } = await import('/scripts/extensions.js');
    const { getRequestHeaders, chat_metadata } = await import('/script.js');
    const { getStringHash, splitRecursive, trimToEndSentence, trimToStartSentence } = await import('/scripts/utils.js');

    const v = extension_settings.vectors;
    const source = v.source;
    const modelKey = { palm: 'google_model', vertexai: 'google_model' }[source] ?? `${source}_model`;
    const model = v[modelKey];

    const files = [
        ...(extension_settings.attachments ?? []).map(f => ({ ...f, scope: 'global' })),
        ...(chat_metadata.attachments ?? []).map(f => ({ ...f, scope: 'chat' })),
        ...Object.entries(extension_settings.character_attachments ?? {})
            .flatMap(([avatar, list]) => list.map(f => ({ ...f, scope: `character:${avatar}` }))),
    ].filter((f, i, arr) => arr.findIndex(x => x.url === f.url) === i);

    const delimiters = ['\n\n', '\n', ' ', ''];
    if (v.force_chunk_delimiter) delimiters.unshift(v.force_chunk_delimiter);

    const expectedHashes = (text, size) => {
        const threshold = v.size_threshold_db * 1024;
        let chunkSize = size > threshold ? v.chunk_size_db : -1;
        const overlapSize = Math.round(chunkSize * v.overlap_percent_db / 100);
        chunkSize = overlapSize > 0 ? chunkSize - overlapSize : chunkSize;
        const overlap = (chunk, index, chunks) => {
            if (overlapSize <= 0) return chunk;
            const half = Math.floor(overlapSize / 2);
            const next = trimToEndSentence(chunks[index + 1]?.substring(0, half)) || '';
            const prev = trimToStartSentence(chunks[index - 1]?.substring(chunks[index - 1].length - half)) || '';
            return [prev, chunk, next].filter(x => x).join(' ');
        };
        const chunks = v.only_custom_boundary && v.force_chunk_delimiter
            ? text.split(v.force_chunk_delimiter).map(overlap)
            : splitRecursive(text, chunkSize, delimiters).map(overlap);
        return chunks.map(c => getStringHash(c));
    };

    const rows = [];
    for (const file of files) {
        const collectionId = `file_${getStringHash(file.url)}`;
        const listRes = await fetch('/api/vector/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ source, model, collectionId }),
        });
        const saved = listRes.ok ? new Set((await listRes.json()).map(Number)) : null;
        const textRes = await fetch(file.url, { headers: getRequestHeaders() });
        const expected = textRes.ok ? expectedHashes(await textRes.text(), file.size) : [];
        const missing = saved ? expected.filter(h => !saved.has(h)).length : null;

        rows.push({
            file: file.name,
            scope: file.scope,
            collectionId,
            saved: saved ? saved.size : 'ERROR',
            expected: expected.length,
            missing,
            status: !saved ? '読み込み失敗' : saved.size === 0 ? '未ベクトル化' : missing > 0 ? '★欠損あり' : 'OK',
        });
    }

    console.log(`source=${source} model=${model}` + (v.translate_files ? ' (translate_files が有効なため expected は参考値)' : ''));
    console.table(rows);
})();
