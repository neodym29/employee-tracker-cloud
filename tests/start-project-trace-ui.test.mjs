import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
function harness(respond) {
  const slots = []; let cursor = 0; const effects = []; const calls = [];
  const jsx = (type, props) => ({type, props});
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= {current: initial}; },
    useCallback(fn) { return fn; },
    useEffect(fn) { effects.push(fn); },
  };
  const module = {exports: {}};
  vm.runInNewContext(ts.transpileModule(read('app/components/TraceMiniProjectDiscovery.tsx'), {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, {
    module, exports: module.exports, Date, console, setInterval, clearInterval,
    fetch: async (url, options) => { calls.push({url, options}); return {ok: true, json: async () => respond(url, options)}; },
    require: p => p === 'react' ? hooks : p === 'react/jsx-runtime' ? {jsx, jsxs: jsx} : {default: 'DesktopCliConnection'},
  });
  return {calls, render(props = {}) {cursor = 0; effects.length = 0; return module.exports.default(props);}, async mount() { await effects[0]?.(); await new Promise(r => setImmediate(r)); }};
}
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]; }
function button(tree, label) { return nodes(tree).find(n => n.type === 'button' && [n.props.children].flat().join('') === label); }
const device = {id:'1', device_label:'Laptop', last_seen_at:new Date().toISOString(), revoked_at:null};
const candidate = {id:'7', display_name:'Widget', repository_key:'github.com/acme/widget', match_status:'matched', matched_project_id:'99', tracking_state:'unselected', revision:3};

test('Trace setup belongs to both creation cards, never below ProjectsClient', () => {
  const page = read('app/projects/page.tsx');
  assert.doesNotMatch(page, /<TraceMiniProjectDiscovery|<DesktopCliConnection/);
  const ui = read('app/projects/ProjectsClient.tsx');
  assert.match(ui, /<TraceMiniProjectDiscovery/);
  assert.equal((ui.match(/\{traceSetup\}/g) || []).length, 2);
  assert.match(ui, /if \(traceSetupOpen\)/);
  assert.match(ui, /setCreatedProjectId\(data.project.id\)/);
});

test('repository selection fills the creation draft without requesting tracking', async () => {
  const h = harness(url => url.includes('devices') ? {ok:true, devices:[device]} : {ok:true, candidates:[candidate]});
  let chosen;
  h.render({onChoose: c => {chosen = c;}}); await h.mount();
  const tree = h.render({onChoose: c => {chosen = c;}});
  assert.ok(button(tree, 'Use repository'));
  button(tree, 'Use repository').props.onClick();
  assert.equal(chosen.id, '7');
  assert.equal(h.calls.filter(c => c.options?.method === 'PUT').length, 0);
});

test('tracking requires an exact server-confirmed project match and sends revision', async () => {
  const h = harness((url, options) => url.includes('devices') ? {ok:true, devices:[device]} : options?.method === 'PUT' ? {ok:true, selection:{revision:4}} : {ok:true, candidates:[candidate]});
  h.render({projectId:'other'}); await h.mount();
  assert.equal(button(h.render({projectId:'other'}), 'Track repository')?.props.disabled, true);
  const tree = h.render({projectId:'99'});
  await button(tree, 'Track repository').props.onClick();
  const put = h.calls.find(c => c.options?.method === 'PUT');
  assert.deepEqual(JSON.parse(put.options.body), {desired_tracking:true, revision:3});
  assert.ok(JSON.stringify(h.render({projectId:'99'})).includes('waiting for CLI confirmation'));
  assert.ok(!JSON.stringify(h.render({projectId:'99'})).includes('Tracking confirmed'));
});

test('server tracking confirmation is rendered only after a successful status read', async () => {
  const h = harness(url => url.includes('devices') ? {ok:true, devices:[device]} : {ok:true, candidates:[{...candidate, tracking_state:'tracking'}]});
  h.render({projectId:'99'}); await h.mount();
  assert.match(JSON.stringify(h.render({projectId:'99'})), /Tracking confirmed by server/);
  assert.ok(button(h.render({projectId:'99'}), 'Stop tracking'));
});

test('failed status refresh locks mutations and exposes an actionable error', async () => {
  const h = harness(() => ({ok:false, error:'Session expired'}));
  h.render(); await h.mount();
  const tree = h.render();
  assert.equal(button(tree, 'Detect projects').props.disabled, true);
  assert.match(JSON.stringify(tree), /Session expired/);
  assert.ok(button(tree, 'Refresh CLI status'));
});

test('local-only repositories cannot populate the required hosted Git remote', async () => {
  const h = harness(url => url.includes('devices') ? {ok:true, devices:[device]} : {ok:true, candidates:[{...candidate, repository_key:'local:abc'}]});
  h.render({onChoose() {}}); await h.mount();
  assert.equal(button(h.render({onChoose() {}}), 'Use repository').props.disabled, true);
});

test('matched repositories offer their existing workspace rather than forcing duplicate creation', async () => {
  const h = harness(url => url.includes('devices') ? {ok:true, devices:[device]} : {ok:true, candidates:[candidate]});
  h.render({onChoose() {}}); await h.mount();
  assert.ok(nodes(h.render({onChoose() {}})).some(n => n.type === 'a' && n.props.href === '/projects/99'));
});

test('offline CLI cannot start a scan and exposes reconnect guidance', async () => {
  const h = harness(url => url.includes('devices') ? {ok:true, devices:[{...device,last_seen_at:'2020-01-01'}]} : {ok:true, candidates:[]});
  h.render(); await h.mount();
  const tree = h.render();
  assert.equal(button(tree, 'Detect projects').props.disabled, true);
  assert.match(JSON.stringify(tree), /offline/i);
});
