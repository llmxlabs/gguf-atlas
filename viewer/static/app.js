'use strict';

const $ = (id) => document.getElementById(id);
// Central theme tokens feed both CSS and the Canvas/WebGL renderers.
const atlasThemes = {
  slate:{name:'Slate',bg:'#10151d',surface:'#18212b',surface2:'#24313e',line:'#354555',muted:'#9caebe',text:'#edf2f6',accent:'#78c6e8',secondary:'#a2b8eb',warning:'#ddb77d',scene:'#0d131b',grid:'#344352',zero:'#1b2733',negative:'#e9a08a',positive:'#78c6e8',negativeName:'coral',positiveName:'cyan',nonfinite:'#f1ce77',roles:['#78c6e8','#b1a1dc','#d5b482','#8da9da','#ce9bae'],quant:['#78c6e8','#b1a1dc','#d5b482','#ce9bae','#8da9da','#8cb8c5','#b69f85','#9aa9be']},
  indigo:{name:'Indigo',bg:'#171322',surface:'#231d32',surface2:'#302740',line:'#493c5c',muted:'#b4a6c7',text:'#f2edf8',accent:'#c3a0ee',secondary:'#a2b7ed',warning:'#e6bc7b',scene:'#120f1c',grid:'#41344f',zero:'#282035',negative:'#e6b56d',positive:'#c3a0ee',negativeName:'amber',positiveName:'lavender',nonfinite:'#ee8fa7',roles:['#b8a0ed','#89b5dd','#e6b56d','#d296c7','#b5bbd8'],quant:['#c3a0ee','#89b5dd','#e6b56d','#d296c7','#b5bbd8','#ab8fae','#c8a18c','#8f9fca']},
  ember:{name:'Ember',bg:'#1c1513',surface:'#2a201b',surface2:'#3a2b23',line:'#564033',muted:'#c0aa98',text:'#f5eee4',accent:'#e9a16a',secondary:'#a6bed8',warning:'#e7c17a',scene:'#17110f',grid:'#47352b',zero:'#2e231e',negative:'#79acdc',positive:'#eea067',negativeName:'blue',positiveName:'orange',nonfinite:'#d59bcb',roles:['#e9a16a','#a6bed8','#d4bb7e','#c99aa6','#b7a3cf'],quant:['#e9a16a','#a6bed8','#d4bb7e','#c99aa6','#b7a3cf','#ba8f6b','#96a7b8','#ccafa0']},
  forest:{name:'Forest',bg:'#101515',surface:'#171d1d',surface2:'#243127',line:'#354638',muted:'#94a59e',text:'#eeeee3',accent:'#b9e3a4',secondary:'#80c8c4',warning:'#d9b77a',scene:'#0e1513',grid:'#34483b',zero:'#17201e',negative:'#5689bb',positive:'#bce39c',negativeName:'blue',positiveName:'green',nonfinite:'#da806a',roles:['#80c8c4','#b9e3a4','#d9b77a','#aba6d9','#c48f97'],quant:['#b9e3a4','#80c8c4','#d9b77a','#a7afd3','#cc9b9b','#6d9f82','#818e9c','#c3c99c']},
};
window.AtlasTheme={id:'slate',current:atlasThemes.slate,rgb(hex){return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);},rgb255(hex){return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));}};
const palette=[...atlasThemes.slate.quant];
function applyTheme(id,persist=true){
  const valid=Object.hasOwn(atlasThemes,id)?id:'slate',theme=atlasThemes[valid];AtlasTheme.id=valid;AtlasTheme.current=theme;document.documentElement.dataset.theme=valid;
  const tokens={bg:theme.bg,surface:theme.surface,surface2:theme.surface2,line:theme.line,muted:theme.muted,text:theme.text,mint:theme.accent,cyan:theme.secondary,amber:theme.warning,'scene-bg':theme.scene,'chart-grid':theme.grid,zero:theme.zero,negative:theme.negative,positive:theme.positive,nonfinite:theme.nonfinite};
  for(const [key,value]of Object.entries(tokens))document.documentElement.style.setProperty(`--${key}`,value);
  document.querySelectorAll('[data-theme-choice]').forEach(button=>{const active=button.dataset.themeChoice===valid;button.setAttribute('aria-pressed',String(active));button.classList.toggle('active',active);});
  if(persist)try{localStorage.setItem('gguf-atlas-theme',valid);}catch{/* Themes remain usable when browser storage is unavailable. */}
  palette.splice(0,palette.length,...theme.quant);if(state.model){renderPrecision();renderLayers();document.querySelectorAll('.layer-cell').forEach(cell=>{const active=cell.dataset.layer===$('layer-filter').value;cell.classList.toggle('active',active);cell.setAttribute('aria-pressed',String(active));});}
  window.dispatchEvent(new CustomEvent('atlas:theme',{detail:{id:valid,theme}}));
}
const state = { models: [], model: null, id: null, selected: null, page: 0, pageSize: 40, sort: 'name', direction: 1, loadToken: 0, sampleToken: 0 };
const number = (n) => typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
const compact = (n) => typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n) : '—';
const precise = (n) => typeof n === 'number' && Number.isFinite(n) ? (Math.abs(n) > 0 && Math.abs(n) < .001 ? n.toExponential(2) : n.toLocaleString('en-US', {maximumSignificantDigits: 4})) : '—';
function bytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const exponent = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** exponent).toFixed(exponent > 1 ? 2 : 1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][exponent]}`;
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined && text !== null) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function status(text, kind = '') { $('status').textContent = text; $('status').className = `status ${kind}`; }
async function request(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Inspector returned HTTP ${response.status} without JSON.`); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || `Request failed: HTTP ${response.status}`);
  return data;
}
function endpoint(route, extra = {}) { return `/api/${route}?${new URLSearchParams({ id: state.id, ...extra })}`; }

async function discover() {
  $('refresh-button').disabled = true;
  $('inspect-button').disabled = true;
  status('Discovering GGUF files in the configured local roots…', 'loading');
  try {
    const data = await request('/api/models');
    state.models = data.models || [];
    const previous = $('model-select').value;
    $('model-select').replaceChildren();
    for (const model of state.models) {
      const option = node('option', `${model.name}  ·  ${bytes(model.size_bytes)}`);
      option.value = model.id;
      option.title = model.path;
      $('model-select').append(option);
    }
    if (state.models.some((m) => m.id === previous)) $('model-select').value = previous;
    else {
    }
    $('model-select').disabled = !state.models.length;
    $('inspect-button').disabled = !state.models.length;
    if (!state.models.length) {
      $('model-select').append(node('option', 'No GGUF files found'));
      status('No local GGUF files found. Add a GGUF under a configured root and refresh, or restart the viewer with another model root.');
    } else {
      status(`${number(state.models.length)} local model files available. Select a file to inspect.`);
      if (!state.model) await inspect();
    }
  } catch (error) { status(error.message, 'error'); }
  finally { $('refresh-button').disabled = false; }
}

async function inspect() {
  const id = $('model-select').value;
  if (!id) return;
  const token = ++state.loadToken;
  ++state.sampleToken;
  $('inspect-button').disabled = true;
  $('model-select').disabled = true;
  $('workspace').hidden = true;
  $('empty-state').hidden = true;
  status('Reading the GGUF header and tensor directory. Weight data stays on disk…', 'loading');
  try {
    const data = await request(`/api/model?${new URLSearchParams({ id })}`);
    if (token !== state.loadToken) return;
    state.id = id;
    state.model = data;
    state.selected = null;
    state.page = 0;
    $('tensor-search').value = '';
    renderModel();
    $('workspace').hidden = false;
    status(`Inspection complete · ${number(data.summary?.tensor_count ?? data.tensors.length)} tensors indexed · source file opened read-only`);
  } catch (error) {
    if (token !== state.loadToken) return;
    status(error.message, 'error');
    $('empty-state').hidden = false;
  } finally {
    if (token === state.loadToken) { $('inspect-button').disabled = false; $('model-select').disabled = false; }
  }
}

function renderModel() {
  const model = state.model;
  const summary = model.summary || {};
  const architecture = model.architecture || {};
  $('model-title').textContent = model.file.name;
  $('model-path').textContent = model.file.path;
  $('model-path').title = model.file.path;
  $('model-title').title = model.file.name;
  $('facts-summary').textContent = `${compact(summary.parameter_count)} parameters · ${bytes(model.file.size_bytes)} · ${number(summary.tensor_count)} tensors`;
  $('warning-count').textContent = model.warnings?.length ? `${number(model.warnings.length)} notices` : '';
  $('file-format').textContent = `GGUF V${model.file.version} / ${architecture.name || 'UNKNOWN ARCHITECTURE'} / ${model.file.endianness || 'UNSPECIFIED ENDIANNESS'}`.toUpperCase();
  $('export-button').href = endpoint('export');
  $('metrics').replaceChildren();
  const metrics = [
    ['STORED PARAMETERS', compact(summary.parameter_count), `${number(summary.parameter_count)} tensor elements`],
    ['FILE FOOTPRINT', bytes(model.file.size_bytes), 'On disk · includes metadata and padding'],
    ['TENSOR COUNT', number(summary.tensor_count), `${(summary.quantization || []).length} storage types`],
    ['DECLARED CONTEXT', compact(architecture.context_length), 'Metadata declaration · tokens'],
  ];
  for (const [label, value, detail] of metrics) {
    const card = node('div', null, 'metric');
    card.append(node('div', label, 'tiny-label'), node('div', value, 'value'), node('div', detail, 'detail'));
    $('metrics').append(card);
  }
  $('warnings').replaceChildren();
  $('warnings').hidden = !model.warnings?.length;
  for (const warning of model.warnings || []) $('warnings').append(node('p', typeof warning === 'string' ? warning : JSON.stringify(warning)));
  $('architecture-facts').replaceChildren();
  const facts = [['Architecture', architecture.name], ['Blocks', architecture.block_count], ['Width', architecture.embedding_length], ['Q heads', architecture.head_count], ['KV heads', architecture.head_count_kv], ['Experts', architecture.expert_count]];
  for (const [label, value] of facts) {
    if (value === undefined || value === null) continue;
    const fact = node('span', null, 'fact');
    fact.append(node('b', typeof value === 'object' ? JSON.stringify(value) : value), document.createTextNode(label));
    $('architecture-facts').append(fact);
  }
  renderLayers();
  renderPrecision();
  $('layer-filter').replaceChildren(new Option('All layers', ''));
  const layerSet = [...new Set(model.tensors.map((t) => t.layer).filter((l) => l !== null && l !== undefined))].sort((a, b) => Number(a) - Number(b));
  for (const layer of layerSet) $('layer-filter').append(new Option(`Layer ${layer}`, String(layer)));
  if (model.tensors.some((t) => t.layer === null || t.layer === undefined)) $('layer-filter').append(new Option('Global tensors', 'global'));
  $('type-filter').replaceChildren(new Option('All types', ''));
  for (const type of [...new Set(model.tensors.map((t) => t.type))].sort()) $('type-filter').append(new Option(type, type));
  renderTensors();
  $('tensor-details').hidden = true;
  $('inspector-empty').hidden = false;
  $('metadata-search').value = '';
  renderMetadata();
  $('api-example').textContent = `GET ${endpoint('model')}\nGET ${endpoint('sample', { tensor: '<tensor name>' })}\nGET ${endpoint('export')}`;
  window.dispatchEvent(new CustomEvent('atlas:model', {detail: model}));
}

function renderLayers() {
  $('layer-map').replaceChildren();
  const layers = (state.model.layers || []).filter((l) => l.index !== null && l.index !== undefined && Number(l.index) >= 0);
  const largest = layers.reduce((maximum, layer) => Math.max(maximum, layer.bytes || 0), 1);
  for (const layer of layers) {
    const cell = node('button', String(layer.index).padStart(2, '0'), 'layer-cell');
    cell.type = 'button';
    cell.dataset.layer = layer.index;
    cell.title = `Layer ${layer.index} · ${number(layer.tensor_count)} tensors · ${bytes(layer.bytes)} · ${compact(layer.parameter_count)} parameters`;
    cell.setAttribute('aria-label', cell.title);
    cell.setAttribute('aria-pressed', 'false');
    const weight = (layer.bytes || 0) / largest;
    const base=AtlasTheme.rgb255(AtlasTheme.current.scene),accent=AtlasTheme.rgb255(AtlasTheme.current.accent);cell.style.backgroundColor=`rgb(${base.map((v,i)=>Math.round(v+(accent[i]-v)*(.1+weight*.27))).join(' ')})`;
    cell.addEventListener('click', () => {
      $('layer-filter').value = String(layer.index);
      state.page = 0;
      renderTensors();
      document.querySelector('.tensor-panel').scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start'});
    });
    $('layer-map').append(cell);
  }
  if (!layers.length) $('layer-map').append(node('p', 'No numbered blocks recognized. Explore the tensor directory below.', 'footnote'));
  $('layer-caption').textContent = `${number(layers.length)} recognized blocks`;
}

function renderPrecision() {
  const quantization = [...(state.model.summary.quantization || [])].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  const total = quantization.reduce((sum, q) => sum + (q.bytes || 0), 0);
  const incomplete = quantization.some((q) => q.bytes === null || q.bytes === undefined);
  $('precision-total').replaceChildren(document.createTextNode(bytes(incomplete ? total : state.model.summary.tensor_bytes)), node('span', incomplete ? 'known storage · incomplete' : 'tensor storage'));
  document.querySelector('.precision-panel .small-badge').textContent = incomplete ? 'BY KNOWN BYTES' : 'BY BYTES';
  $('precision-bar').replaceChildren();
  $('precision-legend').replaceChildren();
  for (const [index, q] of quantization.entries()) {
    const fraction = total ? (q.bytes || 0) / total : 0;
    const color = palette[index % palette.length];
    if (fraction > 0) {
      const segment = node('span');
      segment.style.width = `${fraction * 100}%`;
      segment.style.backgroundColor = color;
      segment.title = `${q.type}: ${(fraction * 100).toFixed(2)}% · ${bytes(q.bytes)}`;
      $('precision-bar').append(segment);
    }
    const row = node('div', null, 'quant-row');
    const swatch = node('i'); swatch.style.backgroundColor = color;
    row.append(swatch, node('span', q.type), node('span', bytes(q.bytes), 'quant-size'), node('span', q.bytes === null || q.bytes === undefined ? 'unknown' : `${(fraction * 100).toFixed(1)}%`, 'quant-pct'));
    row.title = `${number(q.tensor_count)} tensors · ${number(q.parameter_count)} parameters`;
    $('precision-legend').append(row);
  }
}

function filteredTensors() {
  const query = $('tensor-search').value.trim().toLowerCase();
  const layer = $('layer-filter').value;
  const type = $('type-filter').value;
  return state.model.tensors.filter((t) => (!query || `${t.name} ${t.role || ''}`.toLowerCase().includes(query)) && (!type || t.type === type) && (!layer || (layer === 'global' ? t.layer === null || t.layer === undefined : String(t.layer) === layer))).sort((a, b) => {
    const av = a[state.sort], bv = b[state.sort];
    const compare = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''), undefined, {numeric: true});
    return compare * state.direction;
  });
}

function renderTensors() {
  if (!state.model) return;
  const tensors = filteredTensors();
  state.page = Math.min(state.page, Math.max(0, Math.ceil(tensors.length / state.pageSize) - 1));
  const start = state.page * state.pageSize;
  $('tensor-body').replaceChildren();
  $('tensor-count').textContent = `(${number(state.model.tensors.length)})`;
  for (const tensor of tensors.slice(start, start + state.pageSize)) {
    const row = node('tr');
    row.tabIndex = 0;
    row.setAttribute('aria-label', `Inspect ${tensor.name}`);
    row.setAttribute('aria-selected', String(state.selected?.name === tensor.name));
    if (state.selected?.name === tensor.name) row.classList.add('selected');
    row.dataset.tensor = tensor.name;
    const name = node('td', tensor.name, 'tensor-name'); name.title = tensor.name;
    const typeCell = node('td'); typeCell.append(node('span', tensor.type, 'type-badge'));
    row.append(name, node('td', (tensor.shape || []).map(number).join(' × '), 'shape-cell'), typeCell, node('td', compact(tensor.parameter_count), 'numeric'), node('td', bytes(tensor.bytes), 'numeric'));
    row.addEventListener('click', () => selectTensor(tensor));
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectTensor(tensor); } });
    $('tensor-body').append(row);
  }
  if (!tensors.length) { const row = node('tr'); const cell = node('td', 'No tensors match these filters.'); cell.colSpan = 5; row.append(cell); $('tensor-body').append(row); }
  $('table-status').textContent = tensors.length ? `${number(start + 1)}–${number(Math.min(start + state.pageSize, tensors.length))} of ${number(tensors.length)} tensors` : '0 matching tensors';
  $('previous-page').disabled = state.page === 0;
  $('next-page').disabled = start + state.pageSize >= tensors.length;
  document.querySelectorAll('.layer-cell').forEach((cell) => { const active = cell.dataset.layer === $('layer-filter').value; cell.classList.toggle('active', active); cell.setAttribute('aria-pressed', String(active)); });
  document.querySelectorAll('th button[data-sort]').forEach((button) => { button.querySelector('span').textContent = button.dataset.sort === state.sort ? state.direction === 1 ? '↑' : '↓' : '↕'; });
  window.dispatchEvent(new CustomEvent('atlas:layer', {detail: $('layer-filter').value}));
}

function selectTensor(tensor) {
  state.selected = tensor;
  ++state.sampleToken;
  $('inspector-empty').hidden = true;
  $('tensor-details').hidden = false;
  $('sample-view').hidden = true;
  $('sample-button').disabled = false;
  $('sample-status').hidden = false;
  $('sample-status').textContent = 'Sampling reads a small part of this tensor on demand.';
  $('sample-status').className = 'sample-status';
  $('selected-name').textContent = tensor.name;
  $('selected-facts').replaceChildren();
  const facts = [['SHAPE · GGML ORDER', tensor.shape.map(number).join(' × ')], ['STORAGE TYPE', `${tensor.type} · ID ${tensor.type_id}`], ['PARAMETERS', number(tensor.parameter_count)], ['TENSOR BYTES', bytes(tensor.bytes)], ['FILE OFFSET', number(tensor.absolute_offset)], ['INFERRED ROLE', tensor.role || 'Unclassified']];
  for (const [label, value] of facts) { const fact = node('div', null, 'detail-item'); fact.append(node('span', label), node('strong', value)); $('selected-facts').append(fact); }
  renderTensors();
  window.dispatchEvent(new CustomEvent('atlas:tensor', {detail: tensor}));
}

async function sample() {
  if (!state.selected) return;
  const token = ++state.sampleToken;
  const tensor = state.selected;
  $('sample-button').disabled = true;
  $('sample-view').hidden = true;
  $('sample-status').hidden = false;
  $('sample-status').textContent = 'Reading and decoding a bounded sample…';
  $('sample-status').className = 'sample-status';
  try {
    const data = await request(endpoint('sample', {tensor: tensor.name}));
    if (token !== state.sampleToken) return;
    if (!data.supported) { $('sample-status').textContent = data.reason || `Decoded sampling is not available for ${tensor.type}. Tensor structure and storage remain available.`; return; }
    if (!Array.isArray(data.values) || !data.values.length) { $('sample-status').textContent = 'This tensor returned no sample values.'; return; }
    renderSample(data);
    $('sample-status').hidden = true;
    $('sample-view').hidden = false;
  } catch (error) {
    if (token !== state.sampleToken) return;
    $('sample-status').textContent = error.message;
    $('sample-status').className = 'sample-status error';
  } finally { if (token === state.sampleToken) $('sample-button').disabled = false; }
}

function renderSample(data) {
  const values = data.values;
  const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const limit = Math.max(.000001, ...finite.map(Math.abs));
  const cols = Math.min(64, values.length);
  const rows = Math.ceil(values.length / cols);
  const canvas = $('heatmap');
  canvas.width = cols; canvas.height = rows;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(cols, rows);
  for (let i = 0; i < cols * rows; i++) {
    const val = values[i];
    let color = AtlasTheme.rgb255(AtlasTheme.current.zero);
    if (i < values.length && typeof val === 'number' && Number.isFinite(val)) {
      const strength = Math.sqrt(Math.min(1, Math.abs(val) / limit));
      const target = AtlasTheme.rgb255(val >= 0 ? AtlasTheme.current.positive : AtlasTheme.current.negative);
      color = color.map((base, channel) => Math.round(base + (target[channel] - base) * strength));
    } else if (i < values.length) color = AtlasTheme.rgb255(AtlasTheme.current.nonfinite);
    pixels.data.set([...color, 255], i * 4);
  }
  ctx.putImageData(pixels, 0, 0);
  canvas.setAttribute('aria-label', `Heatmap of ${values.length} sampled values packed into ${cols} display columns. ${AtlasTheme.current.negativeName} is negative; ${AtlasTheme.current.positiveName} is positive. A separate warning color marks non-finite values.`);
  $('heatmap-min').textContent = precise(-limit);
  $('heatmap-max').textContent = `+${precise(limit)}`;
  $('sample-layout').textContent = `${number(values.length)} sampled values · ${cols} display columns · packed visualization, not original tensor geometry. Color intensity uses a square-root scale.`;
  $('sample-stats').replaceChildren();
  for (const [label, key] of [['Minimum', 'min'], ['Maximum', 'max'], ['Mean', 'mean'], ['Std. dev.', 'std'], ['Zeros', 'zero_fraction']]) {
    const stat = node('div', null, 'sample-stat');
    const value = data.stats?.[key];
    stat.append(node('span', label), node('b', key === 'zero_fraction' && typeof value === 'number' ? `${(value * 100).toFixed(2)}%` : precise(value)));
    $('sample-stats').append(stat);
  }
  const count = node('div', null, 'sample-stat'); count.append(node('span', 'Values'), node('b', number(values.length))); $('sample-stats').append(count);
  $('histogram').replaceChildren();
  const bins = Array.isArray(data.histogram) ? data.histogram : [];
  const max = Math.max(1, ...bins.map((bin) => bin.count));
  for (const bin of bins) { const bar = node('div'); bar.style.height = `${Math.max(1, bin.count / max * 100)}%`; bar.style.backgroundColor=bin.max<=0?AtlasTheme.current.negative:bin.min>=0?AtlasTheme.current.positive:AtlasTheme.current.secondary;bar.title = `${precise(bin.min)} to ${precise(bin.max)}: ${number(bin.count)} values`; $('histogram').append(bar); }
  $('histogram').setAttribute('aria-label', `Sample distribution, ${bins.length} bins, ${number(values.length)} sampled values.`);
  $('sampling-note').textContent = typeof data.sampling === 'string' ? data.sampling : data.sampling ? JSON.stringify(data.sampling) : 'Statistics describe this bounded sample only.';
  window.dispatchEvent(new CustomEvent('atlas:sample', {detail: data}));
}

function renderMetadata() {
  if (!state.model) return;
  const query = $('metadata-search').value.toLowerCase().trim();
  $('metadata-list').replaceChildren();
  let count = 0;
  for (const [key, value] of Object.entries(state.model.metadata || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (query && !key.toLowerCase().includes(query)) continue;
    const item = node('dl', null, 'metadata-item');
    item.append(node('dt', key), node('dd', typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
    $('metadata-list').append(item); count++;
  }
  if (!count) $('metadata-list').append(node('p', 'No matching metadata keys.', 'footnote'));
}

$('model-form').addEventListener('submit', (event) => { event.preventDefault(); inspect(); });
$('refresh-button').addEventListener('click', discover);
$('sample-button').addEventListener('click', sample);
$('clear-layer').addEventListener('click', () => { $('layer-filter').value = ''; state.page = 0; renderTensors(); });
for (const id of ['tensor-search', 'layer-filter', 'type-filter']) $(id).addEventListener(id === 'tensor-search' ? 'input' : 'change', () => { state.page = 0; renderTensors(); });
$('metadata-search').addEventListener('input', renderMetadata);
$('previous-page').addEventListener('click', () => { state.page--; renderTensors(); });
$('next-page').addEventListener('click', () => { state.page++; renderTensors(); });
document.querySelectorAll('[data-sort]').forEach((button) => button.addEventListener('click', () => { state.direction = state.sort === button.dataset.sort ? -state.direction : 1; state.sort = button.dataset.sort; state.page = 0; renderTensors(); }));
document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach((tab) => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
  document.querySelectorAll('.tab-panel').forEach((panel) => { panel.hidden = panel.id !== `tab-${button.dataset.tab}`; });
}));
document.querySelectorAll('[data-theme-choice]').forEach(button=>button.addEventListener('click',()=>applyTheme(button.dataset.themeChoice)));
let savedTheme='slate';try{savedTheme=localStorage.getItem('gguf-atlas-theme')||'slate';}catch{}
applyTheme(savedTheme,false);
discover();
