// Run: node --test test-core.js (Node 22+ ESM syntax detection; all fetches mocked, no paid calls).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run, tools } from './video-core.js';

const args = { model: 'minimax-h3', prompt: 'A quiet garden', aspectRatio: 'landscape', resolution: '480p', duration: 1 };
const options = { apiKey: 'sk-test-secret', approve: async () => true };
const parse = result => JSON.parse(result.content[0].text);
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const running = { id: '1-test-task', status: 'running', progress: 3 };
async function mocked(fn, body) {
  const previous = globalThis.fetch;
  globalThis.fetch = fn;
  try { await body(); } finally { globalThis.fetch = previous; }
}

test('tool schemas explicit and status is offline without credentials', async () => {
  assert.deepEqual(tools.map(tool => tool.name), ['status', 'generate_video', 'get_task']);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
  await mocked(() => assert.fail('status must not fetch'), async () => {
    const status = parse(await run('status'));
    assert.equal(status.base_url, 'https://grsaiapi.com');
    assert.match(status.credentials, /未配置/);
    assert.equal(parse(await run('status', {}, { region: 'china' })).base_url, 'https://grsai.dakka.com.cn');
  });
});

test('one async submit with approval, explicit settings and metadata', async () => {
  let count = 0; let approved = false;
  await mocked(async (url, init) => {
    count++; assert(approved); assert.equal(url, 'https://grsaiapi.com/v1/api/generate');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, 'Bearer sk-test-secret');
    const body = JSON.parse(init.body); assert.equal(body.replyType, 'async'); assert.equal(body.resolution, '480p'); assert(!Object.hasOwn(body, 'promptSkill'));
    return json(running);
  }, async () => {
    const result = await run('generate_video', args, { ...options, approve: async received => { assert.deepEqual(received, { ...args, region: 'global' }); approved = true; return true; } });
    assert.equal(result.content.length, 1); assert.equal(result.content[0].type, 'text');
    assert.deepEqual(parse(result).metadata, { model: 'minimax-h3', duration: 1, resolution: '480p' });
    assert.equal(count, 1);
  });
});

test('unknown fields, required fields, types and model-specific boundaries reject before fetch', async () => {
  const bad = [
    { ...args, model: undefined }, { ...args, prompt: '' }, { ...args, extra: true }, { ...args, replyType: 'json' },
    { ...args, duration: 0 }, { ...args, duration: 16 }, { ...args, duration: 1.5 }, { ...args, resolution: '1080p', duration: 11 },
    { ...args, resolution: '2k' }, { ...args, aspectRatio: '16:9' }, { ...args, promptSkill: 1 }, { ...args, seed: 1.5 },
    { ...args, firstFrame: 'https://example.com/a.png' }, { ...args, images: Array(10).fill('https://example.com/a.png') },
    { ...args, audios: Array(4).fill('https://example.com/a.mp3') }, { ...args, images: undefined },
    { ...args, region: 'other' },
    { ...args, model: 'agnes-video-2.5', aspectRatio: '16:9', resolution: '720p', duration: 3 },
    { ...args, model: 'agnes-video-2.5', aspectRatio: '16:9', resolution: '720p', duration: 13 },
    { ...args, model: 'agnes-video-2.5', aspectRatio: '16:9', resolution: '720p', duration: 4, promptSkill: true },
    { ...args, model: 'agnes-video-2.5', aspectRatio: '16:9', resolution: '720p', duration: 4, images: Array(6).fill('https://example.com/a.png') },
  ];
  await mocked(() => assert.fail('invalid inputs must not fetch'), async () => {
    for (const input of bad) await assert.rejects(run('generate_video', input, options));
    await assert.rejects(run('generate_video', {}, options));
    await assert.rejects(run('status', { key: 'bad' }));
    await assert.rejects(run('get_task', { id: '' }, options));
    await assert.rejects(run('missing', {}));
  });
});

test('minimax valid boundary combinations and agnes all supported ratios/resolutions', async () => {
  await mocked(async () => json(running), async () => {
    for (const resolution of ['480p', '768p', '1080p']) await run('generate_video', { ...args, resolution, duration: resolution === '1080p' ? 10 : 15, seed: -1, promptSkill: false }, options);
    for (const aspectRatio of ['16:9', '9:16', '21:9', '4:3', '1:1', '3:4']) for (const resolution of ['720p', '1080p', '2k']) await run('generate_video', { ...args, model: 'agnes-video-2.5', aspectRatio, resolution, duration: 12 }, options);
  });
});

test('agnes first/last frames are mutually exclusive with images and audios', async () => {
  const agnes = { ...args, model: 'agnes-video-2.5', aspectRatio: '16:9', resolution: '720p', duration: 4 };
  await mocked(async () => json(running), async () => {
    for (const frame of ['firstFrame', 'lastFrame']) for (const references of ['images', 'audios']) await assert.rejects(run('generate_video', { ...agnes, [frame]: 'https://example.com/frame.png', [references]: ['https://example.com/ref'] }, options), /互斥/);
    await run('generate_video', { ...agnes, firstFrame: 'https://example.com/first.png', lastFrame: 'https://example.com/last.png' }, options);
  });
});

test('every submission needs strict approval; exceptions are redacted', async () => {
  await mocked(() => assert.fail('unapproved requests must not fetch'), async () => {
    for (const approve of [undefined, async () => false, async () => 'true', async () => { throw new Error('sk-test-secret raw'); }]) {
      await assert.rejects(run('generate_video', args, { apiKey: options.apiKey, approve }), error => !error.message.includes('sk-test-secret') && /批准/.test(error.message));
    }
  });
});

test('single query uses GET and URL encoded id, no approval or polling', async () => {
  let calls = 0;
  await mocked(async (url, init) => { calls++; assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(url, 'https://grsai.dakka.com.cn/v1/api/result?id=task%20one%26two'); return json(running); }, async () => {
    assert.equal(parse(await run('get_task', { id: 'task one&two' }, { apiKey: options.apiKey, region: 'china' })).id, running.id);
    assert.equal(calls, 1);
  });
});

test('args region overrides host configuration and approval sees effective region', async () => {
  await mocked(async (url, init) => { assert(url.startsWith('https://grsai.dakka.com.cn/')); if (init.body) assert(!Object.hasOwn(JSON.parse(init.body), 'region')); return json(running); }, async () => {
    await run('get_task', { id: running.id, region: 'china' }, { ...options, region: 'global' });
    await run('generate_video', { ...args, region: 'china' }, { ...options, region: 'global', approve: async approved => { assert.equal(approved.region, 'china'); return true; } });
  });
});

test('valid success URLs only; upstream errors and credentials never echo', async () => {
  for (const url of ['http://example.com/video.mp4', 'https://name:pass@example.com/a', 'javascript:alert(1)', 'not-a-url', 'https://example.com/sk-test-secret']) {
    await mocked(async () => json({ id: running.id, status: 'succeeded', results: [{ url }] }), async () => { await assert.rejects(run('get_task', { id: running.id }, options), error => !error.message.includes('sk-test-secret')); });
  }
  await mocked(async () => json({ id: running.id, status: 'succeeded', results: [{ url: 'https://cdn.example.com/video.mp4?signature=abc' }] }), async () => {
    const result = await run('get_task', { id: running.id }, options);
    assert.deepEqual(parse(result).urls, ['https://cdn.example.com/video.mp4?signature=abc']); assert.equal(result.content[0].type, 'text');
  });
  for (const status of ['failed', 'violation']) await mocked(async () => json({ id: running.id, status, error: 'sk-test-secret raw upstream response' }, 400), async () => {
    const result = await run('get_task', { id: running.id }, options); assert.equal(parse(result).id, running.id); assert(!JSON.stringify(result).includes('sk-test-secret'));
  });
});

test('HTTP, JSON, redirect, oversized responses and transport errors do not retry or leak', async () => {
  const cases = [() => json({ error: 'sk-test-secret raw response' }, 403), () => new Response('sk-test-secret invalid json'), () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }), () => new Response('x', { headers: { 'content-length': String(1024 * 1024 + 1) } }), () => new Response('x'.repeat(1024 * 1024 + 1)), () => { throw new Error('sk-test-secret transport'); }];
  for (const make of cases) {
    let count = 0;
    await mocked(async () => { count++; return make(); }, async () => {
      await assert.rejects(run('get_task', { id: running.id }, options), error => !error.message.includes('sk-test-secret')); assert.equal(count, 1);
    });
  }
});

test('60-second request timeout and external cancellation stop requests without retry', async () => {
  const original = AbortSignal.timeout; const durations = [];
  AbortSignal.timeout = duration => { durations.push(duration); return original(5); };
  try {
    await mocked(async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })), async () => {
      const keeper = setTimeout(() => {}, 1000);
      try { await assert.rejects(run('get_task', { id: running.id }, options), /60秒/); } finally { clearTimeout(keeper); }
    });
    assert(durations.every(value => value === 60_000));
  } finally { AbortSignal.timeout = original; }
  const controller = new AbortController(); controller.abort(new Error('secret reason'));
  await mocked(() => assert.fail('aborted request must not fetch'), async () => { await assert.rejects(run('get_task', { id: running.id }, { ...options, signal: controller.signal }), /取消/); });
});

test('local workspace resources become bare base64; magic, traversal, symlinks and sizes checked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grsai-core-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(path.join(workspace, 'image.png'), png);
  await writeFile(path.join(workspace, 'sound.mp3'), Buffer.from('ID3test'));
  await writeFile(path.join(workspace, 'fake.png'), 'not an image');
  await writeFile(path.join(root, 'outside.png'), png);
  await symlink(path.join(root, 'outside.png'), path.join(workspace, 'escape.png'));
  try {
    await mocked(async (_url, init) => { const body = JSON.parse(init.body); assert.deepEqual(body.images, [png.toString('base64')]); assert.deepEqual(body.audios, [Buffer.from('ID3test').toString('base64')]); return json(running); }, async () => {
      await run('generate_video', { ...args, images: ['image.png'], audios: ['sound.mp3'] }, { ...options, workspace });
    });
    await mocked(() => assert.fail('unsafe local resource must not fetch'), async () => {
      for (const image of ['fake.png', '../outside.png', 'escape.png', 'missing.png', 'http://example.com/a.png', 'https://user:pass@example.com/a.png']) await assert.rejects(run('generate_video', { ...args, images: [image] }, { ...options, workspace }));
    });
    await writeFile(path.join(workspace, 'large.mp3'), Buffer.alloc(20 * 1024 * 1024 + 1));
    await assert.rejects(run('generate_video', { ...args, audios: ['large.mp3'] }, { ...options, workspace }), /20 MiB/);
  } finally {
    assert(path.basename(root).startsWith('grsai-core-') && path.dirname(root) === os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});
