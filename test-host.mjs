import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
if (!process.env.DSH_TEST_REQUIRE_BASE) throw new Error('Set DSH_TEST_REQUIRE_BASE inside DSH.');
const req = createRequire(process.env.DSH_TEST_REQUIRE_BASE); let resolving = false;
registerHooks({ resolve(spec, context, next) {
  if (!resolving && (spec.startsWith('@deepseek-ai/') || spec.startsWith('@modelcontextprotocol/'))) {
    resolving = true; let value; try { value = req.resolve(spec); } finally { resolving = false; }
    return { url: pathToFileURL(value).href, shortCircuit: true };
  }
  return next(spec, context);
} });
const { Config, apply } = await import('./index.js');
const z = (await import('@deepseek-ai/schemastery')).default;
const [config] = z.resolve({}, Config);
assert.equal(config.region.get(), 'global'); assert.equal(config.apiKey.get(), '');
const registered = []; const ctx = { effect(cb) { cb(); }, tools: { register(x) { registered.push(x); return () => {}; } }, get() {} };
apply(ctx, config); assert.equal(registered.length, 3);
const status = registered.find(x => x.name.endsWith('__status'));
const out = await status.execute({}, { signal: new AbortController().signal });
assert.match(JSON.stringify(out), /minimax-h3/); assert.doesNotMatch(JSON.stringify(out), /Bearer/);
console.log('PASS: DSH schema resolves, 3 GrsAI video tools register, offline status executes through official MCP adapter.');
