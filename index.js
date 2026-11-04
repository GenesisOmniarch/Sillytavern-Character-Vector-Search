/**
 * Character Vector Search — SillyTavern extension
 *
 * 標準の Vector Storage 拡張による Data Bank 検索に加えて、
 * 「キャラクターカード全体」をクエリとして Data Bank をベクトル検索し、
 * 結果をプロンプトに挿入します。
 *
 * - 1対1チャット: 応答キャラクターのカードで検索
 * - グループチャット: メンバー全員(または応答キャラのみ)のカードで、人数分検索
 * - Retrieve 件数 / Score threshold は標準 Vector Storage 拡張の設定値
 *   (Data Bank の "Retrieve chunks" と "Score threshold")をそのまま使用
 * - Embedding ソース / モデルも標準 Vector Storage 拡張の設定を使用し、
 *   Data Bank ファイルのコレクションも標準拡張と共有 (file_<hash>)
 */

import {
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    getRequestHeaders,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParams,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getFileAttachment } from '../../../chats.js';
import { getStringHash, splitRecursive, trimToEndSentence, trimToStartSentence, onlyUnique, escapeHtml } from '../../../utils.js';
import { textgen_types, textgenerationwebui_settings } from '../../../textgen-settings.js';
import { oai_settings } from '../../../openai.js';

const MODULE_NAME = 'character_vector_search';
const LOG_PREFIX = 'CharacterVectorSearch:';
export const EXTENSION_PROMPT_TAG = '5_character_vector_search';

/** カードから抽出できるフィールド */
const CARD_FIELDS = {
    name: 'Name',
    description: 'Description',
    personality: 'Personality',
    scenario: 'Scenario',
    first_mes: 'First message',
    alternate_greetings: 'Alternate greetings',
    mes_example: 'Examples of dialogue',
    system_prompt: 'System prompt (card)',
    post_history_instructions: 'Post-history instructions (card)',
    depth_prompt: 'Character\'s note (depth prompt)',
    creator_notes: 'Creator\'s notes',
    tags: 'Tags',
};

const defaultSettings = {
    enabled: true,
    include_muted: true,
    // 'own' = 共通(Global + Chat) + そのキャラ自身の Character attachments
    // 'all_members' = 共通 + 対象キャラ全員の Character attachments を各キャラで検索
    scope: 'own',
    fields: {
        name: true,
        description: true,
        personality: true,
        scenario: true,
        first_mes: true,
        alternate_greetings: false,
        mes_example: true,
        system_prompt: true,
        post_history_instructions: true,
        depth_prompt: true,
        creator_notes: false,
        tags: false,
    },
    // クエリ文字数上限 (0 = 無制限)。Embedding モデルの入力上限対策
    max_query_chars: 0,
    // 標準拡張と同様に1回だけ適用。{{text}} = 全員分の検索結果(キャラごとのブロックに分けたもの)
    template: 'Related information:\n{{text}}',
    position: extension_prompt_types.IN_PROMPT,
    depth: 4,
    role: extension_prompt_roles.SYSTEM,
    include_wi: false,
    cache_results: true,
};

/** @type {typeof defaultSettings} */
let settings;

/**
 * クエリ結果キャッシュ。カードが変わらない限り同じ結果になるため、
 * グループで各メンバーが応答するたびに再度 Embedding するのを避ける。
 * @type {Map<string, Record<string, { hashes: number[], metadata: object[] }>>}
 */
const queryCache = new Map();
/** 取り込み済み/取り込み中のコレクション */
const ingestedCollections = new Set();
/** @type {Map<string, Promise<void>>} */
const ingestInFlight = new Map();

let webllmProvider = null;

// ---------------------------------------------------------------------------
// Vector Storage (標準拡張) の設定を参照するヘルパー
// ---------------------------------------------------------------------------

/** @returns {any} 標準 Vector Storage 拡張の設定 */
function vs() {
    return extension_settings.vectors ?? {};
}

function getRetrieveCount() {
    const value = Number(vs().chunk_count_db);
    return Number.isFinite(value) && value > 0 ? value : 5;
}

function getScoreThreshold() {
    const value = Number(vs().score_threshold);
    return Number.isFinite(value) ? value : 0.25;
}

function getSource() {
    return vs().source || 'transformers';
}

function getFileCollectionId(fileUrl) {
    return `file_${getStringHash(fileUrl)}`;
}

/**
 * 標準拡張の getVectorsRequestBody と同等。
 * @param {object} args
 */
function getVectorsRequestBody(args = {}) {
    const v = vs();
    const body = Object.assign({}, args);
    switch (getSource()) {
        case 'extras':
            body.extrasUrl = extension_settings.apiUrl;
            body.extrasKey = extension_settings.apiKey;
            break;
        case 'electronhub':
            body.model = v.electronhub_model;
            break;
        case 'openrouter':
            body.model = v.openrouter_model;
            break;
        case 'togetherai':
            body.model = v.togetherai_model;
            break;
        case 'openai':
            body.model = v.openai_model;
            break;
        case 'cohere':
            body.model = v.cohere_model;
            break;
        case 'ollama':
            body.model = v.ollama_model;
            body.apiUrl = v.use_alt_endpoint ? v.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
            body.keep = !!v.ollama_keep;
            break;
        case 'llamacpp':
            body.apiUrl = v.use_alt_endpoint ? v.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP];
            break;
        case 'vllm':
            body.apiUrl = v.use_alt_endpoint ? v.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.VLLM];
            body.model = v.vllm_model;
            break;
        case 'webllm':
            body.model = v.webllm_model;
            break;
        case 'palm':
            body.model = v.google_model;
            body.api = 'makersuite';
            break;
        case 'vertexai':
            body.model = v.google_model;
            body.api = 'vertexai';
            body.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
            body.vertexai_region = oai_settings.vertexai_region;
            body.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
            break;
        case 'chutes':
            body.model = v.chutes_model;
            break;
        case 'nanogpt':
            body.model = v.nanogpt_model;
            break;
        case 'siliconflow':
            body.model = v.siliconflow_model;
            body.siliconflow_endpoint = oai_settings.siliconflow_endpoint;
            break;
        case 'workers_ai':
            body.model = v.workers_ai_model || '@cf/baai/bge-m3';
            body.workers_ai_account_id = oai_settings.workers_ai_account_id;
            break;
        default:
            break;
    }
    return body;
}

/** モデル識別子(キャッシュキー用) */
function getModelKey() {
    const body = getVectorsRequestBody();
    return `${getSource()}|${body.model ?? ''}|${body.apiUrl ?? ''}`;
}

async function createKoboldCppEmbeddings(items) {
    const v = vs();
    const response = await fetch('/api/backends/kobold/embed', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            items: items,
            server: v.use_alt_endpoint ? v.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.KOBOLDCPP],
        }),
    });

    if (!response.ok) {
        throw new Error('Failed to get KoboldCpp embeddings');
    }

    const data = await response.json();
    if (!Array.isArray(data.embeddings) || !data.model || data.embeddings.length !== items.length) {
        throw new Error('Invalid response from KoboldCpp embeddings');
    }

    const embeddings = {};
    for (let i = 0; i < data.embeddings.length; i++) {
        embeddings[items[i]] = data.embeddings[i];
    }
    return { embeddings, model: data.model };
}

async function createWebLlmEmbeddings(items) {
    if (items.length === 0) {
        return {};
    }
    if (!webllmProvider) {
        const { WebLlmVectorProvider } = await import('../../vectors/webllm.js');
        webllmProvider = new WebLlmVectorProvider();
    }
    const embeddings = await webllmProvider.embedTexts(items, vs().webllm_model);
    const result = {};
    for (let i = 0; i < items.length; i++) {
        result[items[i]] = embeddings[i];
    }
    return result;
}

/**
 * クライアント側で Embedding を作る必要があるソース用の追加引数
 * @param {string[]} items
 */
async function getAdditionalArgs(items) {
    const args = {};
    switch (getSource()) {
        case 'webllm':
            args.embeddings = await createWebLlmEmbeddings(items);
            break;
        case 'koboldcpp': {
            const { embeddings, model } = await createKoboldCppEmbeddings(items);
            args.embeddings = embeddings;
            args.model = model;
            break;
        }
    }
    return args;
}

async function getSavedHashes(collectionId) {
    const args = await getAdditionalArgs([]);
    const response = await fetch('/api/vector/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(args),
            collectionId: collectionId,
            source: getSource(),
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to get saved hashes for collection ${collectionId}`);
    }

    return await response.json();
}

async function insertVectorItems(collectionId, items) {
    const args = await getAdditionalArgs(items.map(x => x.text));
    const response = await fetch('/api/vector/insert', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(args),
            collectionId: collectionId,
            items: items,
            source: getSource(),
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to insert vector items for collection ${collectionId}`);
    }
}

/**
 * @param {string[]} collectionIds
 * @param {string} searchText
 * @param {number} topK
 * @param {number} threshold
 * @returns {Promise<Record<string, { hashes: number[], metadata: object[] }>>}
 */
async function queryMultipleCollections(collectionIds, searchText, topK, threshold) {
    const args = await getAdditionalArgs([searchText]);
    const response = await fetch('/api/vector/query-multi', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getVectorsRequestBody(args),
            collectionIds: collectionIds,
            searchText: searchText,
            topK: topK,
            source: getSource(),
            threshold: threshold,
        }),
    });

    if (!response.ok) {
        throw new Error('Failed to query multiple collections');
    }

    return await response.json();
}

// ---------------------------------------------------------------------------
// Data Bank
// ---------------------------------------------------------------------------

function isAttachmentDisabled(attachment) {
    return (extension_settings.disabled_attachments ?? []).some(url => url === attachment?.url);
}

/** Global + Chat の Data Bank 添付 */
function getCommonAttachments() {
    const context = getContext();
    const global = extension_settings.attachments ?? [];
    const chat = context.chatMetadata?.attachments ?? [];
    return [...global, ...chat].filter(x => !isAttachmentDisabled(x));
}

/** 指定キャラの Character Data Bank 添付 */
function getCharacterAttachments(avatar) {
    const list = extension_settings.character_attachments?.[avatar] ?? [];
    return list.filter(x => !isAttachmentDisabled(x));
}

function getChunkDelimiters() {
    const delimiters = ['\n\n', '\n', ' ', ''];
    if (vs().force_chunk_delimiter) {
        delimiters.unshift(vs().force_chunk_delimiter);
    }
    return delimiters;
}

function overlapChunks(chunk, index, chunks, overlapSize) {
    const halfOverlap = Math.floor(overlapSize / 2);
    const nextChunk = chunks[index + 1];
    const prevChunk = chunks[index - 1];
    const nextOverlap = trimToEndSentence(nextChunk?.substring(0, halfOverlap)) || '';
    const prevOverlap = trimToStartSentence(prevChunk?.substring(prevChunk.length - halfOverlap)) || '';
    return [prevOverlap, chunk, nextOverlap].filter(x => x).join(' ');
}

/**
 * 標準拡張と同じ分割設定でファイルをベクトル化する
 * (標準拡張側がまだ取り込んでいないファイル、例: 他のグループメンバーのキャラ添付 用)
 */
async function vectorizeFile(file, collectionId) {
    const v = vs();
    let fileText = await getFileAttachment(file.url);
    if (!fileText) {
        return;
    }

    if (v.translate_files && typeof globalThis.translate === 'function') {
        fileText = await globalThis.translate(fileText, 'en');
    }

    const thresholdLength = (Number(v.size_threshold_db) || 5) * 1024;
    let chunkSize = file.size > thresholdLength ? (Number(v.chunk_size_db) || 2500) : -1;
    const overlapPercent = Number(v.overlap_percent_db) || 0;
    const overlapSize = Math.round(chunkSize * overlapPercent / 100);
    chunkSize = overlapSize > 0 ? (chunkSize - overlapSize) : chunkSize;
    const applyOverlap = (x, y, z) => overlapSize > 0 ? overlapChunks(x, y, z, overlapSize) : x;
    const chunks = v.only_custom_boundary && v.force_chunk_delimiter
        ? fileText.split(v.force_chunk_delimiter).map(applyOverlap)
        : splitRecursive(fileText, chunkSize, getChunkDelimiters()).map(applyOverlap);

    const items = chunks.map((chunk, index) => ({ hash: getStringHash(chunk), text: chunk, index }));
    const batchSize = ['transformers', 'ollama'].includes(getSource()) ? 1 : 5;

    const toastBody = $('<span>').text('Please wait...');
    const toast = toastr.info(toastBody, `Character Vector Search: ingesting ${escapeHtml(file.name)}`, { closeButton: false, escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });
    try {
        for (let i = 0; i < items.length; i += batchSize) {
            toastBody.text(`${i}/${items.length} chunks processed`);
            await insertVectorItems(collectionId, items.slice(i, i + batchSize));
        }
        console.log(`${LOG_PREFIX} Inserted ${items.length} chunks for ${file.name} into ${collectionId}`);
    } finally {
        toastr.clear(toast);
    }
}

/**
 * ファイルが未取り込みなら取り込み、コレクション ID を返す
 * @param {object[]} files
 * @returns {Promise<string[]>}
 */
async function ensureIngested(files) {
    const ids = [];
    const sourceKey = getModelKey();

    for (const file of files) {
        const collectionId = getFileCollectionId(file.url);
        const key = `${sourceKey}|${collectionId}`;
        ids.push(collectionId);

        if (ingestedCollections.has(key)) {
            continue;
        }

        if (!ingestInFlight.has(key)) {
            ingestInFlight.set(key, (async () => {
                const hashes = await getSavedHashes(collectionId);
                if (!hashes.length) {
                    console.log(`${LOG_PREFIX} Data Bank file ${file.name} is not vectorized yet, ingesting...`);
                    await vectorizeFile(file, collectionId);
                }
                ingestedCollections.add(key);
            })().finally(() => ingestInFlight.delete(key)));
        }

        try {
            await ingestInFlight.get(key);
        } catch (error) {
            console.error(`${LOG_PREFIX} Failed to ingest ${file.name}`, error);
        }
    }

    return ids.filter(onlyUnique);
}

// ---------------------------------------------------------------------------
// キャラクターカード
// ---------------------------------------------------------------------------

/**
 * キャラクターカード全体を検索用テキストにする
 * @param {any} character
 * @returns {string}
 */
function buildCardText(character) {
    const data = character?.data ?? {};
    const pick = (key) => data[key] ?? character?.[key] ?? '';
    const name = character?.name ?? '';
    const f = settings.fields;
    const parts = [];

    const push = (enabled, label, value) => {
        if (!enabled) return;
        const text = Array.isArray(value) ? value.filter(Boolean).join('\n\n') : String(value ?? '');
        if (text.trim()) {
            parts.push(`${label}:\n${text.trim()}`);
        }
    };

    push(f.name, 'Name', name);
    push(f.description, 'Description', pick('description'));
    push(f.personality, 'Personality', pick('personality'));
    push(f.scenario, 'Scenario', pick('scenario'));
    push(f.first_mes, 'First message', pick('first_mes'));
    push(f.alternate_greetings, 'Alternate greetings', data.alternate_greetings ?? []);
    push(f.mes_example, 'Examples of dialogue', pick('mes_example'));
    push(f.system_prompt, 'System prompt', data.system_prompt);
    push(f.post_history_instructions, 'Post-history instructions', data.post_history_instructions);
    push(f.depth_prompt, 'Character note', data.extensions?.depth_prompt?.prompt);
    push(f.creator_notes, 'Creator notes', data.creator_notes ?? character?.creatorcomment);
    push(f.tags, 'Tags', Array.isArray(data.tags) ? data.tags.join(', ') : (Array.isArray(character?.tags) ? character.tags.join(', ') : ''));

    // {{char}} などのマクロを「そのキャラ」の名前で展開。
    // 第2引数を null にすると新旧どちらの ST でも (content, name1, name2) の旧シグネチャとして解釈される
    let text = substituteParams(parts.join('\n\n'), null, name);
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    const max = Number(settings.max_query_chars) || 0;
    if (max > 0 && text.length > max) {
        text = text.substring(0, max);
    }
    return text;
}

/**
 * 今回検索対象のキャラクター一覧を取得
 * @returns {{ character: any, chid: number }[]}
 */
function getTargetCharacters() {
    const context = getContext();
    const characters = context.characters ?? [];
    const result = [];

    if (context.groupId) {
        const group = (context.groups ?? []).find(g => g.id === context.groupId);
        if (!group) return result;

        for (const avatar of group.members ?? []) {
            if (!settings.include_muted && (group.disabled_members ?? []).includes(avatar)) {
                continue;
            }
            const chid = characters.findIndex(c => c.avatar === avatar);
            if (chid >= 0) {
                result.push({ character: characters[chid], chid });
            }
        }
        return result;
    }

    const chid = Number(context.characterId);
    if (Number.isInteger(chid) && chid >= 0 && characters[chid]) {
        result.push({ character: characters[chid], chid });
    }
    return result;
}

// ---------------------------------------------------------------------------
// 検索 & 挿入
// ---------------------------------------------------------------------------

/**
 * @param {string[]} collectionIds
 * @param {string} queryText
 */
async function cachedQuery(collectionIds, queryText) {
    const topK = getRetrieveCount();
    const threshold = getScoreThreshold();
    const key = [getModelKey(), topK, threshold, [...collectionIds].sort().join(','), getStringHash(queryText)].join('|');

    if (settings.cache_results && queryCache.has(key)) {
        return queryCache.get(key);
    }

    const result = await queryMultipleCollections(collectionIds, queryText, topK, threshold);
    if (settings.cache_results) {
        queryCache.set(key, result);
    }
    return result;
}

/**
 * 対象キャラ全員分の検索を実行(キャラごとに独立した結果を返す)
 * @returns {Promise<{ name: string, avatar: string, chunks: string[] }[]>}
 */
async function searchForCharacters() {
    const targets = getTargetCharacters();
    if (!targets.length) {
        return [];
    }

    const common = getCommonAttachments();
    const allMemberFiles = settings.scope === 'all_members'
        ? targets.flatMap(t => getCharacterAttachments(t.character.avatar))
        : [];

    const results = [];
    for (const { character } of targets) {
        const files = settings.scope === 'all_members'
            ? [...common, ...allMemberFiles]
            : [...common, ...getCharacterAttachments(character.avatar)];

        const uniqueFiles = files.filter((f, i, arr) => arr.findIndex(x => x.url === f.url) === i);
        if (!uniqueFiles.length) {
            continue;
        }

        const queryText = buildCardText(character);
        if (!queryText) {
            continue;
        }

        const collectionIds = await ensureIngested(uniqueFiles);
        if (!collectionIds.length) {
            continue;
        }

        const queryResults = await cachedQuery(collectionIds, queryText);
        const chunks = [];
        for (const collectionId of Object.keys(queryResults)) {
            const metadata = queryResults[collectionId]?.metadata ?? [];
            chunks.push(...metadata.filter(x => x.text).sort((a, b) => a.index - b.index).map(x => x.text));
        }

        console.debug(`${LOG_PREFIX} ${character.name}: ${chunks.length} chunks`, queryResults);
        results.push({ name: character.name, avatar: character.avatar, chunks: chunks.filter(onlyUnique) });
    }

    return results;
}

/** ブロックの区切りタグ。本文中に同じタグがあっても区切りが壊れないようにエスケープする */
const BLOCK_TAG = 'character_reference';

function escapeAttribute(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function neutralizeBlockTags(text) {
    return String(text ?? '').replace(new RegExp(`<(/?)(${BLOCK_TAG})`, 'gi'), '&lt;$1$2');
}

/**
 * 1キャラ分の結果を、持ち主が明確なブロックにする。
 *   <character_reference name="Alice">
 *   ...Alice のカードで検索したチャンク...
 *   </character_reference>
 * @param {{ name: string, chunks: string[] }} result
 * @returns {string}
 */
function formatCharacterBlock({ name, chunks }) {
    if (!chunks.length) {
        return '';
    }
    // 資料本文中の {{char}} はそのブロックの持ち主の名前で展開する(応答キャラ名にしない)。
    // 第2引数 null → 新旧どちらの ST でも (content, name1, name2) の旧シグネチャとして解釈される
    const body = chunks
        .map(c => neutralizeBlockTags(substituteParams(c, null, name)).trim())
        .filter(Boolean)
        .join('\n\n');
    if (!body) {
        return '';
    }
    return `<${BLOCK_TAG} name="${escapeAttribute(name)}">\n${body}\n</${BLOCK_TAG}>`;
}

/**
 * 全員分のブロックを作り、Injection Template に1回だけ当てはめる。
 * テンプレートの内容に関係なく成立するよう、
 *  - テンプレート側のマクロ ({{char}}, {{user}} など) は通常どおり展開
 *  - {{text}} は展開後に文字列としてそのまま差し込む(テンプレート側のマクロ展開で資料本文が二重展開されない)
 *  - {{text}} が無いテンプレートでも、末尾に全員分のブロックを付ける
 *  - テンプレートが空なら全員分のブロックのみ
 * @param {{ name: string, chunks: string[] }[]} results
 * @returns {string}
 */
function formatResults(results) {
    const blocks = results.map(formatCharacterBlock).filter(Boolean);
    if (!blocks.length) {
        return '';
    }
    const text = blocks.join('\n\n');
    const template = String(settings.template ?? '');
    const textMacro = /\{\{\s*text\s*\}\}/gi;

    if (!template.trim()) {
        return text;
    }

    const marker = `CVSTEXTMARKER${Date.now()}${Math.random().toString(36).slice(2)}`;
    const hasTextMacro = textMacro.test(template);
    textMacro.lastIndex = 0;
    const rendered = substituteParams(template.replace(textMacro, marker));

    if (!hasTextMacro || !rendered.includes(marker)) {
        return `${rendered.replaceAll(marker, '').trimEnd()}\n${text}`;
    }
    return rendered.split(marker).join(text);
}

function clearPrompt() {
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, settings.include_wi, settings.role);
}

/**
 * generate_interceptor
 * @param {any[]} _chat
 * @param {number} _contextSize
 * @param {function} _abort
 * @param {string} type
 */
async function interceptor(_chat, _contextSize, _abort, type) {
    try {
        clearPrompt();

        if (!settings.enabled || type === 'quiet') {
            return;
        }

        // 毎回、全員分のカードで検索し、全員分の参考資料をキャラごとのブロックに分けて {{text}} に入れる
        const results = await searchForCharacters();
        const insertedText = formatResults(results);
        if (!insertedText) {
            console.debug(`${LOG_PREFIX} No relevant Data Bank chunks found`);
            return;
        }

        console.log(`${LOG_PREFIX} Injecting reference material\n`, insertedText);
        setExtensionPrompt(EXTENSION_PROMPT_TAG, insertedText, Number(settings.position), Number(settings.depth), settings.include_wi, Number(settings.role));
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed`, error);
        toastr.error(String(error?.message ?? error), 'Character Vector Search', { preventDuplicates: true });
    }
}

globalThis.characterVectorSearch_interceptor = interceptor;

// ---------------------------------------------------------------------------
// 設定 UI
// ---------------------------------------------------------------------------

function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] ?? {};
    const s = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (s[key] === undefined) {
            s[key] = structuredClone(value);
        }
    }
    for (const [key, value] of Object.entries(defaultSettings.fields)) {
        if (s.fields[key] === undefined) {
            s.fields[key] = value;
        }
    }
    // 旧バージョンの設定を整理(応答キャラのみ挿入/まとめて挿入は廃止)
    delete s.inject_mode;
    delete s.group_mode;
    delete s.dedupe;
    delete s.char_template;
    if (['Character-related information:\n{{text}}', 'Reference material for {{char}}:\n{{text}}'].includes(s.template)) {
        s.template = defaultSettings.template;
    }
    settings = s;
}

function updateInheritedInfo() {
    $('#cvs_inherited_info').text(
        `Source: ${getSource()} / Retrieve chunks: ${getRetrieveCount()} / Score threshold: ${getScoreThreshold()}`,
    );
}

function bindSettings() {
    const bindCheckbox = (id, key) => {
        $(id).prop('checked', !!settings[key]).on('input', function () {
            settings[key] = $(this).prop('checked');
            saveSettingsDebounced();
        });
    };
    const bindText = (id, key, numeric = false) => {
        $(id).val(settings[key]).on('input', function () {
            const raw = String($(this).val());
            settings[key] = numeric ? Number(raw) : raw;
            saveSettingsDebounced();
        });
    };

    bindCheckbox('#cvs_enabled', 'enabled');
    bindCheckbox('#cvs_include_muted', 'include_muted');
    bindCheckbox('#cvs_include_wi', 'include_wi');
    bindCheckbox('#cvs_cache_results', 'cache_results');
    bindText('#cvs_scope', 'scope');
    bindText('#cvs_max_query_chars', 'max_query_chars', true);
    bindText('#cvs_template', 'template');
    bindText('#cvs_depth', 'depth', true);
    bindText('#cvs_role', 'role', true);

    $(`input[name="cvs_position"][value="${settings.position}"]`).prop('checked', true);
    $('input[name="cvs_position"]').on('change', function () {
        settings.position = Number($(this).val());
        saveSettingsDebounced();
    });

    const fieldsContainer = $('#cvs_fields');
    for (const [key, label] of Object.entries(CARD_FIELDS)) {
        const id = `cvs_field_${key}`;
        const row = $('<label class="checkbox_label"></label>').attr('for', id);
        const input = $('<input type="checkbox">').attr('id', id).prop('checked', !!settings.fields[key]);
        input.on('input', function () {
            settings.fields[key] = $(this).prop('checked');
            saveSettingsDebounced();
        });
        row.append(input, $('<span></span>').text(label));
        fieldsContainer.append(row);
    }

    $('#cvs_clear_cache').on('click', () => {
        queryCache.clear();
        ingestedCollections.clear();
        toastr.success('Cache cleared', 'Character Vector Search');
    });

    $('#cvs_test').on('click', async () => {
        try {
            updateInheritedInfo();
            const results = await searchForCharacters();
            if (!results.length) {
                $('#cvs_test_output').text('No target characters / no Data Bank files');
                return;
            }
            // 毎回の生成で実際に挿入される内容を表示
            const summary = results.map(r => `${r.name}: ${r.chunks.length} chunks`).join(' / ');
            const output = `${summary}\n\n${formatResults(results) || '(nothing)'}`;
            console.log(`${LOG_PREFIX} Test search\n${output}`);
            $('#cvs_test_output').text(output);
        } catch (error) {
            console.error(`${LOG_PREFIX} Test failed`, error);
            toastr.error(String(error?.message ?? error), 'Character Vector Search');
        }
    });

    $('#cvs_inline_drawer_toggle').on('click', updateInheritedInfo);
    updateInheritedInfo();
}

async function addSettingsUi() {
    const url = new URL('./settings.html', import.meta.url);
    const response = await fetch(url);
    if (!response.ok) {
        console.error(`${LOG_PREFIX} Failed to load settings.html`);
        return;
    }
    const html = await response.text();
    $('#extensions_settings2').append(html);
    bindSettings();
}

jQuery(async () => {
    loadSettings();
    await addSettingsUi();

    // キャラカードが編集されたらキャッシュは自然に無効化される(クエリのハッシュが変わる)。
    // ファイル削除時は取り込み済みフラグを破棄する。
    eventSource.on(event_types.FILE_ATTACHMENT_DELETED, () => {
        ingestedCollections.clear();
        queryCache.clear();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        clearPrompt();
        updateInheritedInfo();
    });
});
