// Dependency-free Node ESM core. Credentials are supplied by the host and never persisted.
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

const GLOBAL_BASE = 'https://grsaiapi.com';
const CHINA_BASE = 'https://grsai.dakka.com.cn';
const TIMEOUT = 60_000;
const RESPONSE_LIMIT = 1024 * 1024;
const RESOURCE_LIMIT = 20 * 1024 * 1024;
const TOTAL_RESOURCE_LIMIT = 64 * 1024 * 1024;
const MODELS = ['minimax-h3', 'agnes-video-2.5'];
const STATUSES = ['running', 'succeeded', 'failed', 'violation'];

const resource = { type: 'string', minLength: 1, description: '公网HTTPS URL或工作区内本地路径；本地文件读取后转为裸base64（官方支持，但尚未经付费端到端验证）。' };
export const tools = [
  { name: 'status', description: '检查视频插件配置，不联网、不消耗额度、不显示密钥。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'generate_video', description: '提交一次异步视频任务，不轮询、不重试。必须显式指定模型、分辨率等参数；每次提交均需明确批准。', inputSchema: {
    type: 'object', additionalProperties: false, required: ['model', 'prompt', 'aspectRatio', 'resolution', 'duration'],
    properties: {
      region: { type: 'string', enum: ['global', 'china'], description: '可选覆盖主机配置的API节点。' },
      model: { type: 'string', enum: MODELS }, prompt: { type: 'string', minLength: 1 },
      aspectRatio: { type: 'string', enum: ['portrait', 'landscape', '16:9', '9:16', '21:9', '4:3', '1:1', '3:4'] },
      resolution: { type: 'string', enum: ['480p', '768p', '720p', '1080p', '2k'] }, duration: { type: 'integer' },
      images: { type: 'array', items: resource, maxItems: 9 }, audios: { type: 'array', items: resource, maxItems: 3 },
      firstFrame: resource, lastFrame: resource, seed: { type: 'integer' }, promptSkill: { type: 'boolean', description: '仅minimax-h3；官方默认true，省略时不覆盖上游默认。' },
    },
  } },
  { name: 'get_task', description: '单次查询异步任务状态；不忙轮询、不重试。', inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 256 }, region: { type: 'string', enum: ['global', 'china'], description: '可选覆盖主机配置；查询任务时使用提交任务的节点。' } } } },
];

class CoreError extends Error {}
function fail(message) { throw new CoreError(message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function exactKeys(name, args) {
  const tool = tools.find(item => item.name === name);
  if (!tool) fail('未知工具。');
  if (!isObject(args)) fail('工具参数必须为对象。');
  const schema = tool.inputSchema;
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) || (schema.required ?? []).some(key => !Object.hasOwn(args, key))) fail('工具参数缺失或包含未知字段。');
}
function nonempty(value, label, max = 20_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`${label}格式无效。`);
}
function list(value, label, max) {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !item)) fail(`${label}格式或数量无效。`);
}
function validate(name, args) {
  exactKeys(name, args);
  if (name === 'status') return null;
  if (Object.hasOwn(args, 'region') && !['global', 'china'].includes(args.region)) fail('region仅支持global或china。');
  if (name === 'get_task') {
    nonempty(args.id, 'id', 256);
    if (/[\r\n]/.test(args.id)) fail('id格式无效。');
    return { id: args.id };
  }
  if (!MODELS.includes(args.model)) fail('model必须显式为minimax-h3或agnes-video-2.5。');
  nonempty(args.prompt, 'prompt');
  if (!Number.isInteger(args.duration)) fail('duration必须是整数。');
  if (Object.hasOwn(args, 'seed') && !Number.isInteger(args.seed)) fail('seed必须是整数。');
  if (Object.hasOwn(args, 'images')) list(args.images, 'images', args.model === 'minimax-h3' ? 9 : 5);
  if (Object.hasOwn(args, 'audios')) list(args.audios, 'audios', 3);
  for (const key of ['firstFrame', 'lastFrame']) if (Object.hasOwn(args, key) && (typeof args[key] !== 'string' || !args[key])) fail(`${key}格式无效。`);
  if (args.model === 'minimax-h3') {
    if (!['portrait', 'landscape'].includes(args.aspectRatio)) fail('minimax-h3的aspectRatio仅支持portrait或landscape。');
    if (!['480p', '768p', '1080p'].includes(args.resolution)) fail('minimax-h3的resolution仅支持480p、768p或1080p。');
    if (args.duration < 1 || args.duration > 15 || (args.resolution === '1080p' && args.duration > 10)) fail('minimax-h3时长须为1–15秒，1080p最多10秒。');
    if (Object.hasOwn(args, 'firstFrame') || Object.hasOwn(args, 'lastFrame')) fail('firstFrame和lastFrame仅支持agnes-video-2.5。');
    if (Object.hasOwn(args, 'promptSkill') && typeof args.promptSkill !== 'boolean') fail('promptSkill必须是boolean。');
  } else {
    if (!['16:9', '9:16', '21:9', '4:3', '1:1', '3:4'].includes(args.aspectRatio)) fail('agnes-video-2.5的aspectRatio无效。');
    if (!['720p', '1080p', '2k'].includes(args.resolution)) fail('agnes-video-2.5的resolution仅支持720p、1080p或2k。');
    if (args.duration < 4 || args.duration > 12) fail('agnes-video-2.5时长须为4–12秒。');
    if (Object.hasOwn(args, 'promptSkill')) fail('promptSkill仅支持minimax-h3。');
    if ((Object.hasOwn(args, 'firstFrame') || Object.hasOwn(args, 'lastFrame')) && ((args.images?.length ?? 0) || (args.audios?.length ?? 0))) fail('按字段文档，首尾帧与images、audios互斥。');
  }
  return { ...args, replyType: 'async' };
}

function httpsReference(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) fail('参考资源URL仅允许无用户名密码的HTTPS地址。');
  return parsed.href;
}
function imageMagic(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return;
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return;
  fail('本地图片仅支持按magic识别的PNG、JPEG或WebP。');
}
function audioValid(data, target) {
  const mp3 = data.subarray(0, 3).toString('ascii') === 'ID3' || (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
  const wav = data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE';
  const m4a = data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp';
  return mp3 || wav || m4a || ['.mp3', '.wav', '.m4a'].includes(path.extname(target).toLowerCase());
}
async function localResource(root, value, kind, signal) {
  let target;
  try { target = await realpath(path.resolve(root, value)); } catch { fail(`本地${kind === 'image' ? '图片' : '音频'}路径无效。`); }
  if (!contained(root, target)) fail('本地资源必须是工作区内实际文件；拒绝越界或symlink。');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > RESOURCE_LIMIT) fail('本地资源无效或超过20 MiB限制。');
    signal.throwIfAborted();
    const chunks = []; let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal.throwIfAborted(); size += chunk.length;
      if (size > RESOURCE_LIMIT) fail('本地资源超过20 MiB限制。');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks, size);
    if (!data.length) fail('本地资源不能为空。');
    if (kind === 'image') imageMagic(data);
    else if (!audioValid(data, target)) fail('本地音频仅支持MP3、WAV或M4A（magic或扩展名校验）。');
    return data;
  } finally { await file.close(); }
}
async function materialize(root, fields, signal) {
  let total = 0;
  const convert = async (value, kind) => {
    const remote = httpsReference(value);
    if (remote) return remote;
    const data = await localResource(root, value, kind, signal);
    total += data.length;
    if (total > TOTAL_RESOURCE_LIMIT) fail('本地参考资源合计超过64 MiB限制。');
    return data.toString('base64');
  };
  const body = { ...fields };
  delete body.region;
  if (fields.images) body.images = await Promise.all(fields.images.map(value => convert(value, 'image')));
  if (fields.audios) body.audios = await Promise.all(fields.audios.map(value => convert(value, 'audio')));
  if (fields.firstFrame) body.firstFrame = await convert(fields.firstFrame, 'image');
  if (fields.lastFrame) body.lastFrame = await convert(fields.lastFrame, 'image');
  return body;
}

async function readBounded(response, signal) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > RESPONSE_LIMIT) { await response.body?.cancel?.().catch(() => {}); fail('API响应超过1 MiB限制。'); }
  if (!response.body?.[Symbol.asyncIterator]) fail('API响应不可读取。');
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    const bytes = Buffer.from(chunk); total += bytes.length;
    if (total > RESPONSE_LIMIT) { await response.body?.cancel?.().catch(() => {}); fail('API响应超过1 MiB限制。'); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}
function decodeURIComponentSafe(value) { try { return decodeURIComponent(value); } catch { return value; } }
function validResultUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function normalize(data, metadata, apiKey) {
  if (!isObject(data) || typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.id) || data.id.includes(apiKey) || !STATUSES.includes(data.status)) fail('API响应缺少可验证的任务id或状态。');
  const out = { id: data.id, status: data.status };
  if (Number.isInteger(data.progress) && data.progress >= 0 && data.progress <= 100) out.progress = data.progress;
  if (data.status === 'succeeded') {
    if (!Array.isArray(data.results) || !data.results.length) fail(`成功响应缺少视频链接；任务id：${data.id}。`);
    const urls = data.results.map(row => isObject(row) ? validResultUrl(row.url) : null);
    if (urls.some(url => !url || url.includes(apiKey) || decodeURIComponentSafe(url).includes(apiKey))) fail(`成功响应包含无效视频URL；任务id：${data.id}。`);
    out.urls = urls;
  }
  if (metadata) out.metadata = metadata;
  return out;
}
async function request(base, endpoint, init, apiKey, signal, metadata) {
  const response = await fetch(base + endpoint, { ...init, redirect: 'manual', signal, headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': 'DSH-Grsai-Video/1.0', ...(init.headers ?? {}) } });
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel?.().catch(() => {}); fail('API意外重定向；已拒绝转发凭据，不会重试。'); }
  const bytes = await readBounded(response, signal);
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { fail('API返回无效JSON；不会重试。'); }
  // Error responses can carry a durable task id. Preserve it without exposing upstream error text.
  if (!response.ok) {
    if (isObject(data) && typeof data.id === 'string' && STATUSES.includes(data.status)) return normalize(data, metadata, apiKey);
    fail(`视频API返回HTTP ${response.status}；请检查权限、参数与中转日志。不会自动重试。`);
  }
  return normalize(data, metadata, apiKey);
}
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
function text(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }

/** Run one MCP tool. generate_video always requires approve(args) === true before fetch. */
export async function run(name, args = {}, { workspace = process.cwd(), apiKey, region, signal: externalSignal, approve } = {}) {
  let signal; let submitted = false;
  try {
    const fields = validate(name, args);
    const effectiveRegion = args.region ?? region ?? 'global';
    if (!['global', 'china', 'cn'].includes(effectiveRegion)) fail('region仅支持global、china或cn。');
    const base = ['china', 'cn'].includes(effectiveRegion) ? CHINA_BASE : GLOBAL_BASE;
    if (name === 'status') return text({ available_models: MODELS, base_url: base, reply_type: 'async', timeout_seconds: 60, response_limit_mib: 1, local_resource_limit_mib: 20, credentials: typeof apiKey === 'string' && apiKey.trim() ? '已配置密钥（未联网验证）' : '未配置密钥，请在本机配置，勿在聊天中发送。' });
    signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT);
    signal.throwIfAborted();
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) fail('API密钥未配置或格式无效；请在本机配置，勿在聊天中发送。');
    if (name === 'get_task') {
      const result = await abortable(request(base, `/v1/api/result?id=${encodeURIComponent(fields.id)}`, { method: 'GET' }, apiKey.trim(), signal), signal);
      return text(result);
    }
    if (typeof approve !== 'function') fail('视频提交需要本次交互明确批准；未发起API请求。');
    let approved;
    try { approved = await abortable(approve({ ...structuredClone(args), region: base === CHINA_BASE ? 'china' : 'global' }), signal); } catch { if (signal.aborted) signal.throwIfAborted(); fail('视频提交批准失败；未发起API请求。'); }
    if (approved !== true) fail('视频提交未获明确批准；未发起API请求。');
    signal.throwIfAborted();
    const root = await realpath(path.resolve(workspace));
    const body = await materialize(root, fields, signal);
    signal.throwIfAborted(); submitted = true;
    const result = await abortable(request(base, '/v1/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, apiKey.trim(), signal, { model: fields.model, duration: fields.duration, resolution: fields.resolution }), signal);
    return text(result);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    if (signal?.aborted || externalSignal?.aborted) throw new Error(`视频操作已取消或超过60秒。${submitted ? '请求可能已提交，请用已获得的任务id或中转记录核查；' : '未确认提交；'}不会自动重试。`);
    throw new Error(`视频操作失败；请检查工作区、网络及中转日志。${submitted ? '请求可能已提交；' : ''}不会自动重试，且未暴露上游原文。`);
  }
}
