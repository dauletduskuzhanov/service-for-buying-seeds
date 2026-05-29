/* =========================================================================
   Закуп подсолнечника — прототип Этапа 1 (MVP)
   Автономный SPA: база КХ, запуск опроса (модель WhatsApp), сбор и разбор
   ответов, дашборд из 4 блоков + таблица. Состояние — в localStorage.
   ========================================================================= */

'use strict';

const STORE_KEY = 'mez_zakup_v1';
const fmt = new Intl.NumberFormat('ru-RU');
const money = (n) => n == null ? '—' : fmt.format(Math.round(n));

/* ----------------------------- состояние ------------------------------- */
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return freshState();
}

function freshState() {
  return {
    settings: structuredCopy(SEED_SETTINGS),
    farms: SEED_FARMS.map((f) => ({ ...f, tags: [...f.tags] })),
    survey: null,          // { date, sentIds: [] }
    responses: {},         // farmId -> { volume, humidity, impurity, oil, price, raw, time, status }
  };
}

function structuredCopy(o) { return JSON.parse(JSON.stringify(o)); }
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

/* --------------------------- утилиты данных ----------------------------- */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Дорожное приближение: прямую дистанцию умножаем на коэффициент извилистости.
function roadDistance(farm) {
  const p = state.settings.plant;
  return Math.round(haversine(p.lat, p.lon, farm.lat, farm.lon) * 1.25);
}

function farmById(id) { return state.farms.find((f) => f.id === id); }
function activeFarms() { return state.farms.filter((f) => f.status === 'active'); }

// Категория качества по приёмочным нормам.
function qualityCategory(r) {
  if (!r || (r.humidity == null && r.impurity == null && r.oil == null)) return 'unknown';
  const n = state.settings.norms;
  const fail = (r.humidity != null && r.humidity > n.maxHumidity)
    || (r.impurity != null && r.impurity > n.maxImpurity)
    || (r.oil != null && r.oil < n.minOil);
  if (fail) return 'low';
  // «высшее»: с запасом по всем трём (если все заполнены)
  const great = (r.humidity != null && r.humidity <= n.maxHumidity - 1)
    && (r.impurity != null && r.impurity <= n.maxImpurity - 1)
    && (r.oil != null && r.oil >= n.minOil + 2);
  return great ? 'high' : 'standard';
}

const QUALITY_META = {
  high:     { label: 'Высшее',      color: '#1f7a4d' },
  standard: { label: 'Стандарт',    color: '#b4690e' },
  low:      { label: 'Низкое / брак', color: '#b3261e' },
  unknown:  { label: 'Не указано',  color: '#c2c8d0' },
};

function passesNorms(r) {
  const c = qualityCategory(r);
  return c === 'high' || c === 'standard';
}

// Список «предложений дня»: активные КХ, которым отправлен опрос.
function offers() {
  if (!state.survey) return [];
  return state.survey.sentIds.map((id) => {
    const farm = farmById(id);
    if (!farm) return null;
    const r = state.responses[id] || null;
    return {
      id, farm, r,
      distance: roadDistance(farm),
      volume: r?.volume ?? null,
      price: r?.price ?? null,
      quality: qualityCategory(r),
      answered: !!r,
    };
  }).filter(Boolean);
}

/* --------------------------- парсинг ответа ----------------------------- */
// Грубый разбор свободного текста фермера в 4 числовых поля.
function parseMessage(text) {
  const t = (text || '').toLowerCase().replace(/ /g, ' ');
  const out = { volume: null, humidity: null, impurity: null, oil: null, price: null };

  // Цена: число с «тыс»/«000» рядом со словом цена/по/тенге, либо самое крупное число.
  const priceM = t.match(/(?:цена|по|тенге|тг)\D{0,6}(\d[\d\s.,]*)\s*(тыс|т\.?р|000)?/);
  if (priceM) {
    let v = num(priceM[1]);
    if (/тыс/.test(priceM[2] || '') && v < 10000) v *= 1000;
    if (v != null && v < 10000) v *= 1000; // «235» как тыс
    out.price = v;
  }

  // Объём: число рядом с «т»/«тонн» (без опоры на \b — оно не работает с кириллицей).
  const volM = t.match(/(\d[\d\s.,]*)\s*(?:тонн|тн|т)(?![а-яёa-z0-9])/);
  if (volM) out.volume = num(volM[1]);

  // Влажность / сорность / масличность. \w/\b не матчат кириллицу, поэтому
  // от основы слова до числа допускаем любые не-цифры [^\d] (окончание, пробел, знаки).
  out.humidity = pickPct(t, /влажн[^\d]{0,8}(\d[\d.,]*)/) ?? pickPct(t, /(?:^|[\s,])вл\.?[^\d]{0,4}(\d[\d.,]*)/);
  out.impurity = pickPct(t, /сор[^\d]{0,8}(\d[\d.,]*)/);
  out.oil      = pickPct(t, /маслич[^\d]{0,8}(\d[\d.,]*)/) ?? pickPct(t, /(?:^|[\s,])масл\.?[^\d]{0,4}(\d[\d.,]*)/);

  return out;
}
function num(s) {
  if (s == null) return null;
  const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.'));
  return isNaN(v) ? null : v;
}
function pickPct(t, re) { const m = t.match(re); return m ? num(m[1]) : null; }

/* ============================== РЕНДЕР ================================== */
function render() {
  renderHeader();
  renderKpi();
  renderDistance();
  renderVolume();
  renderQuality();
  renderPrice();
  renderTable();
  renderFarms();
  save();
}

/* шапка */
function renderHeader() {
  const d = new Date();
  document.getElementById('todayLabel').textContent =
    d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const st = document.getElementById('surveyStatus');
  if (!state.survey) {
    st.textContent = 'опрос не запущен';
    st.classList.remove('is-live');
  } else {
    const sent = state.survey.sentIds.length;
    const ans = state.survey.sentIds.filter((id) => state.responses[id]).length;
    st.textContent = `отправлено ${sent} · ответили ${ans}`;
    st.classList.add('is-live');
  }
  document.getElementById('btnSimulate').style.display = state.survey ? '' : 'none';
}

/* KPI */
function renderKpi() {
  const list = offers().filter((o) => o.answered);
  const totalVol = list.reduce((s, o) => s + (o.volume || 0), 0);
  const withPrice = list.filter((o) => o.price != null);
  const avg = withPrice.length ? withPrice.reduce((s, o) => s + o.price, 0) / withPrice.length : null;
  const wVolBase = withPrice.filter((o) => o.volume);
  const wsum = wVolBase.reduce((s, o) => s + o.volume, 0);
  const wAvg = wsum ? wVolBase.reduce((s, o) => s + o.price * o.volume, 0) / wsum : null;
  const answered = list.length, total = state.survey ? state.survey.sentIds.length : 0;

  const kpis = [
    { label: 'Доступный объём', value: money(totalVol), unit: 'т', sub: `${withPrice.length} предложений с ценой` },
    { label: 'Ответили КХ', value: `${answered}`, unit: `/ ${total}`, sub: total ? `${Math.round(answered / total * 100)}% базы опроса` : 'опрос не запущен' },
    { label: 'Средняя цена', value: money(avg), unit: avg ? 'тг/т' : '', sub: 'простое среднее' },
    { label: 'Средневзвеш. цена', value: money(wAvg), unit: wAvg ? 'тг/т' : '', sub: 'с учётом объёмов' },
  ];
  document.getElementById('kpiRow').innerHTML = kpis.map((k) => `
    <div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}${k.unit ? `<span class="unit">${k.unit}</span>` : ''}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');
}

/* Блок 1 — расстояние */
function renderDistance() {
  const el = document.getElementById('blockDistance');
  const list = offers().filter((o) => o.answered && o.volume);
  if (!list.length) return void (el.innerHTML = emptyMsg());

  const bands = buildBands();
  bands.forEach((b) => {
    const inB = list.filter((o) => o.distance >= b.from && o.distance < b.to);
    b.vol = inB.reduce((s, o) => s + o.volume, 0);
    const wp = inB.filter((o) => o.price != null);
    const ws = wp.reduce((s, o) => s + o.volume, 0);
    b.price = ws ? wp.reduce((s, o) => s + o.price * o.volume, 0) / ws : null;
  });
  const maxVol = Math.max(1, ...bands.map((b) => b.vol));

  el.innerHTML = bands.map((b) => `
    <div class="dist-row">
      <div class="dist-label">${b.label}<small>${b.count(list)} КХ</small></div>
      <div class="bar"><div class="bar-fill" style="width:${b.vol / maxVol * 100}%"></div></div>
      <div class="dist-meta"><b>${money(b.vol)} т</b><small>${b.price ? money(b.price) + ' тг/т' : '—'}</small></div>
    </div>`).join('');
}
function buildBands() {
  const edges = [0, ...state.settings.bands];
  const arr = [];
  for (let i = 0; i < edges.length; i++) {
    const from = edges[i], to = edges[i + 1] ?? Infinity;
    arr.push({
      from, to,
      label: to === Infinity ? `${from}+ км` : `${from}–${to} км`,
      count: (list) => list.filter((o) => o.distance >= from && o.distance < to).length,
    });
  }
  return arr;
}

/* Блок 2 — количество */
function renderVolume() {
  const el = document.getElementById('blockVolume');
  const list = offers().filter((o) => o.answered && o.volume).sort((a, b) => b.volume - a.volume);
  if (!list.length) return void (el.innerHTML = emptyMsg());

  const max = list[0].volume;
  const top = list.slice(0, 5);
  const small = list.filter((o) => o.volume < 100).length;
  const mid = list.filter((o) => o.volume >= 100 && o.volume < 300).length;
  const big = list.filter((o) => o.volume >= 300).length;

  el.innerHTML = top.map((o, i) => `
    <div class="rank">
      <div class="rank-no">${i + 1}</div>
      <div class="rank-name" title="${esc(o.farm.name)}">${esc(o.farm.name)}</div>
      <div class="rank-bar"><div class="bar"><div class="bar-fill" style="width:${o.volume / max * 100}%"></div></div></div>
      <div class="rank-val">${money(o.volume)} т</div>
    </div>`).join('') + `
    <div class="split">
      <div class="split-item"><b>${small}</b><span>мелкие &lt;100 т</span></div>
      <div class="split-item"><b>${mid}</b><span>средние 100–300 т</span></div>
      <div class="split-item"><b>${big}</b><span>крупные ≥300 т</span></div>
    </div>`;
}

/* Блок 3 — качество */
function renderQuality() {
  const el = document.getElementById('blockQuality');
  const list = offers().filter((o) => o.answered);
  if (!list.length) return void (el.innerHTML = emptyMsg());

  const counts = { high: 0, standard: 0, low: 0, unknown: 0 };
  list.forEach((o) => counts[o.quality]++);
  const total = list.length;
  const order = ['high', 'standard', 'low', 'unknown'];

  const segs = order.filter((k) => counts[k]).map((k) =>
    `<span style="width:${counts[k] / total * 100}%;background:${QUALITY_META[k].color}"></span>`).join('');
  const legend = order.map((k) => `
    <div class="qlegend-row">
      <span class="dot" style="background:${QUALITY_META[k].color}"></span>
      <span class="qname">${QUALITY_META[k].label}</span>
      <span class="qcount">${counts[k]}</span>
    </div>`).join('');

  const reject = list.filter((o) => o.quality === 'low').length;
  const n = state.settings.norms;
  const note = reject
    ? `<div class="reject-note">⚠ ${reject} ${plural(reject, 'партия', 'партии', 'партий')} не ${plural(reject, 'проходит', 'проходят', 'проходят')} по нормам (вл. ≤${n.maxHumidity}%, сор. ≤${n.maxImpurity}%, масл. ≥${n.minOil}%)</div>`
    : `<div class="reject-note ok">✓ Все указанные партии проходят по приёмочным нормам</div>`;

  el.innerHTML = `<div class="qbar">${segs}</div><div class="qlegend">${legend}</div>${note}`;
}

/* Блок 4 — цена */
function renderPrice() {
  const el = document.getElementById('blockPrice');
  const list = offers().filter((o) => o.answered && o.price != null);
  if (!list.length) return void (el.innerHTML = emptyMsg());

  const prices = list.map((o) => o.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
  const target = state.settings.targetPrice;

  // гистограмма по 5 корзинам
  const bins = 5;
  const lo = Math.min(min, target), hi = Math.max(max, target);
  const span = (hi - lo) || 1, step = span / bins;
  const buckets = Array.from({ length: bins }, (_, i) => ({
    from: lo + i * step, to: lo + (i + 1) * step, n: 0,
  }));
  prices.forEach((p) => {
    let idx = Math.floor((p - lo) / step);
    if (idx >= bins) idx = bins - 1; if (idx < 0) idx = 0;
    buckets[idx].n++;
  });
  const maxN = Math.max(1, ...buckets.map((b) => b.n));

  const stats = `
    <div class="price-stats">
      <div class="price-stat"><span>Минимум</span><b>${money(min)}</b></div>
      <div class="price-stat"><span>Средняя</span><b>${money(avg)}</b></div>
      <div class="price-stat"><span>Максимум</span><b>${money(max)}</b></div>
      <div class="price-stat"><span>Целевая</span><b>${money(target)}</b></div>
    </div>`;
  const hist = `<div class="hist">${buckets.map((b) => {
    const mid = (b.from + b.to) / 2;
    const cls = mid <= target ? 'below' : 'above';
    return `<div class="hist-col" title="${b.n} предлож.">
        <div class="hist-bar ${cls}" style="height:${b.n / maxN * 100}%"></div>
        <div class="hist-x"><b>${b.n}</b>${Math.round(b.from / 1000)}–${Math.round(b.to / 1000)} тыс</div>
      </div>`;
  }).join('')}</div>
  <div class="target-line"><span class="swatch"></span>зелёным — предложения не дороже целевой (${money(target)} тг/т)</div>`;

  el.innerHTML = stats + hist;
}

/* Детальная таблица */
let sortKey = 'distance', sortDir = 1;
function renderTable() {
  const body = document.getElementById('offersBody');
  let list = offers();

  const q = document.getElementById('tableSearch').value.trim().toLowerCase();
  const filter = document.getElementById('tableFilter').value;
  if (q) list = list.filter((o) => o.farm.name.toLowerCase().includes(q) || o.farm.town.toLowerCase().includes(q));
  if (filter === 'answered') list = list.filter((o) => o.answered);
  else if (filter === 'waiting') list = list.filter((o) => !o.answered);
  else if (filter === 'accept') list = list.filter((o) => o.answered && passesNorms(o.r));
  else if (filter === 'reject') list = list.filter((o) => o.answered && o.quality === 'low');

  list.sort((a, b) => {
    let av, bv;
    switch (sortKey) {
      case 'name': av = a.farm.name; bv = b.farm.name; break;
      case 'quality': av = a.quality; bv = b.quality; break;
      case 'status': av = a.answered ? 1 : 0; bv = b.answered ? 1 : 0; break;
      default: av = a[sortKey] ?? Infinity; bv = b[sortKey] ?? Infinity;
    }
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return 0;
  });

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty-cell" style="text-align:center;padding:28px">${state.survey ? 'Нет предложений по фильтру' : 'Запустите опрос, чтобы собрать предложения'}</td></tr>`;
    return;
  }

  const target = state.settings.targetPrice;
  body.innerHTML = list.map((o) => {
    const r = o.r;
    const reject = o.answered && o.quality === 'low';
    const qm = QUALITY_META[o.quality];
    const qCell = o.answered
      ? `<span class="pill ${o.quality === 'low' ? 'bad' : o.quality === 'high' ? 'good' : o.quality === 'unknown' ? 'muted' : 'warn'}">${qm.label}</span>`
        + (r && (r.humidity != null || r.impurity != null || r.oil != null)
            ? `<div class="muted" style="margin-top:3px">${qBits(r)}</div>` : '')
      : '<span class="empty-cell">—</span>';
    const priceCell = !o.answered ? '<span class="empty-cell">—</span>'
      : o.price != null
        ? `<span class="${o.price <= target ? 'pill good' : ''}">${money(o.price)}</span>`
        : '<span class="flag-empty">нет</span>';
    const volCell = !o.answered ? '<span class="empty-cell">—</span>'
      : o.volume != null ? money(o.volume) : '<span class="flag-empty">нет</span>';
    const status = o.answered
      ? '<span class="pill accent">данные внесены</span>'
      : '<span class="pill muted">ждём ответ</span>';
    const wa = waLink(o.farm.phone);

    return `<tr class="${reject ? 'row-reject' : ''}">
      <td class="name-cell">${esc(o.farm.name)}<div class="muted">${esc(o.farm.town)}</div></td>
      <td class="num">${o.distance}</td>
      <td class="num">${volCell}</td>
      <td>${qCell}</td>
      <td class="num">${priceCell}</td>
      <td>${status}</td>
      <td class="row-actions">
        <button class="icon-btn" data-edit-resp="${o.id}">${o.answered ? 'Править' : 'Внести'}</button>
        <a class="icon-btn" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>
      </td>
    </tr>`;
  }).join('');
}
function qBits(r) {
  const p = [];
  if (r.humidity != null) p.push(`вл ${r.humidity}%`);
  if (r.impurity != null) p.push(`сор ${r.impurity}%`);
  if (r.oil != null) p.push(`масл ${r.oil}%`);
  return p.join(' · ');
}

/* База КХ */
function renderFarms() {
  const body = document.getElementById('farmsBody');
  const q = document.getElementById('farmSearch').value.trim().toLowerCase();
  let list = state.farms.map((f) => ({ ...f, distance: roadDistance(f) }));
  if (q) list = list.filter((f) => f.name.toLowerCase().includes(q) || f.town.toLowerCase().includes(q) || f.contact.toLowerCase().includes(q));
  list.sort((a, b) => a.distance - b.distance);

  document.getElementById('farmsCount').textContent =
    `${state.farms.length} хозяйств · ${activeFarms().length} активных`;

  body.innerHTML = list.map((f) => `
    <tr>
      <td class="name-cell">${esc(f.name)}${f.notes ? `<div class="muted">${esc(f.notes)}</div>` : ''}</td>
      <td>${esc(f.contact)}</td>
      <td><a class="link-wa" href="${waLink(f.phone)}" target="_blank" rel="noopener">${esc(f.phone)}</a></td>
      <td>${esc(f.town)}</td>
      <td class="num">${f.distance}</td>
      <td>${f.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="empty-cell">—</span>'}</td>
      <td><span class="pill ${f.status === 'active' ? 'good' : 'muted'}">${f.status === 'active' ? 'активный' : 'неактивный'}</span></td>
      <td class="row-actions">
        <button class="icon-btn" data-edit-farm="${f.id}">Править</button>
        <button class="icon-btn" data-toggle-farm="${f.id}">${f.status === 'active' ? 'Выкл' : 'Вкл'}</button>
      </td>
    </tr>`).join('');
}

/* ------------------------------ helpers -------------------------------- */
function emptyMsg() { return `<div class="empty-cell" style="padding:18px 0;text-align:center">${state.survey ? 'Пока нет данных' : 'Запустите опрос'}</div>`; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function waLink(phone) { return 'https://wa.me/' + String(phone).replace(/[^\d]/g, ''); }
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
function toast(msg) {
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/* ============================== ДЕЙСТВИЯ ================================ */
function launchSurvey() {
  const ids = activeFarms().map((f) => f.id);
  if (!ids.length) return toast('Нет активных КХ для опроса');
  const today = new Date().toISOString().slice(0, 10);
  state.survey = { date: today, sentIds: ids };
  state.responses = {};
  render();
  toast(`Опрос отправлен · ${ids.length} ${plural(ids.length, 'хозяйству', 'хозяйствам', 'хозяйствам')}`);
}

// Демо: «приходят» входящие из SEED_INCOMING, разбираются автоматически.
function simulateResponses() {
  if (!state.survey) return;
  let added = 0;
  const now = new Date().toISOString();
  state.survey.sentIds.forEach((id) => {
    if (state.responses[id]) return;
    const raw = SEED_INCOMING[id];
    if (!raw) return;            // часть КХ не отвечает
    const p = parseMessage(raw);
    state.responses[id] = { ...p, raw, time: now, status: 'parsed' };
    added++;
  });
  render();
  toast(added ? `Получено ответов: ${added}` : 'Новых ответов нет');
}

/* ============================== МОДАЛКИ ================================= */
const overlay = document.getElementById('modalOverlay');
function openModal(title, html) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = html;
  overlay.classList.remove('is-hidden');
}
function closeModal() { overlay.classList.add('is-hidden'); }

/* --- ответ КХ --- */
function openResponseModal(id) {
  const farm = farmById(id);
  const r = state.responses[id] || {};
  const f = (v) => v == null ? '' : v;
  openModal(`Ответ · ${farm.name}`, `
    ${r.raw ? `<div class="orig-msg">${esc(r.raw)}</div>` : ''}
    <button class="btn btn-ghost btn-sm" id="reparseBtn" ${r.raw ? '' : 'style="display:none"'}>↻ Разобрать заново из текста</button>
    <div class="modal-grid" style="margin-top:14px">
      <label class="full">Исходный текст из WhatsApp
        <textarea id="rRaw" rows="2" placeholder="Вставьте сообщение фермера…">${esc(r.raw || '')}</textarea>
      </label>
      <label>Объём, т<input type="number" id="rVol" step="0.1" value="${f(r.volume)}" /></label>
      <label>Цена, тг/т<input type="number" id="rPrice" step="100" value="${f(r.price)}" /></label>
      <label>Влажность, %<input type="number" id="rHum" step="0.1" value="${f(r.humidity)}" /></label>
      <label>Сорность, %<input type="number" id="rImp" step="0.1" value="${f(r.impurity)}" /></label>
      <label>Масличность, %<input type="number" id="rOil" step="0.1" value="${f(r.oil)}" /></label>
    </div>
    <p class="parse-hint">Поля можно заполнить автоматически из текста кнопкой «Разобрать», затем поправить вручную.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-close>Отмена</button>
      <button class="btn btn-primary" id="saveResp">Сохранить</button>
    </div>`);

  const reparse = () => {
    const p = parseMessage(document.getElementById('rRaw').value);
    document.getElementById('rVol').value = f(p.volume);
    document.getElementById('rPrice').value = f(p.price);
    document.getElementById('rHum').value = f(p.humidity);
    document.getElementById('rImp').value = f(p.impurity);
    document.getElementById('rOil').value = f(p.oil);
    toast('Текст разобран — проверьте поля');
  };
  document.getElementById('reparseBtn').onclick = reparse;

  document.getElementById('saveResp').onclick = () => {
    const g = (id) => { const v = document.getElementById(id).value; return v === '' ? null : parseFloat(v); };
    state.responses[id] = {
      volume: g('rVol'), price: g('rPrice'),
      humidity: g('rHum'), impurity: g('rImp'), oil: g('rOil'),
      raw: document.getElementById('rRaw').value, time: new Date().toISOString(), status: 'confirmed',
    };
    closeModal(); render(); toast('Ответ сохранён');
  };
}

/* --- карточка КХ --- */
function openFarmModal(id) {
  const f = id ? farmById(id) : { name: '', contact: '', phone: '', town: '', lat: '', lon: '', status: 'active', tags: [], notes: '' };
  openModal(id ? `Карточка · ${f.name}` : 'Новое хозяйство', `
    <div class="modal-grid">
      <label class="full">Название<input type="text" id="fName" value="${esc(f.name)}" /></label>
      <label>Контактное лицо<input type="text" id="fContact" value="${esc(f.contact)}" /></label>
      <label>WhatsApp<input type="tel" id="fPhone" value="${esc(f.phone)}" placeholder="+7 7.. ... ...." /></label>
      <label>Населённый пункт<input type="text" id="fTown" value="${esc(f.town)}" /></label>
      <label>Статус
        <select id="fStatus">
          <option value="active" ${f.status === 'active' ? 'selected' : ''}>активный</option>
          <option value="inactive" ${f.status === 'inactive' ? 'selected' : ''}>неактивный</option>
        </select>
      </label>
      <label>Широта<input type="number" id="fLat" step="0.0001" value="${f.lat}" /></label>
      <label>Долгота<input type="number" id="fLon" step="0.0001" value="${f.lon}" /></label>
      <label class="full">Теги (через запятую)<input type="text" id="fTags" value="${esc(f.tags.join(', '))}" /></label>
      <label class="full">Заметки<textarea id="fNotes" rows="2">${esc(f.notes)}</textarea></label>
    </div>
    <p class="parse-hint" id="distPreview"></p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-close>Отмена</button>
      <button class="btn btn-primary" id="saveFarm">Сохранить</button>
    </div>`);

  const updatePreview = () => {
    const lat = parseFloat(document.getElementById('fLat').value);
    const lon = parseFloat(document.getElementById('fLon').value);
    const el = document.getElementById('distPreview');
    if (!isNaN(lat) && !isNaN(lon)) {
      const km = Math.round(haversine(state.settings.plant.lat, state.settings.plant.lon, lat, lon) * 1.25);
      el.textContent = `Расстояние до завода ≈ ${km} км (рассчитано по координатам).`;
    } else el.textContent = 'Укажите координаты — расстояние рассчитается автоматически.';
  };
  document.getElementById('fLat').addEventListener('input', updatePreview);
  document.getElementById('fLon').addEventListener('input', updatePreview);
  updatePreview();

  document.getElementById('saveFarm').onclick = () => {
    const name = document.getElementById('fName').value.trim();
    if (!name) return toast('Укажите название');
    const data = {
      name,
      contact: document.getElementById('fContact').value.trim(),
      phone: document.getElementById('fPhone').value.trim(),
      town: document.getElementById('fTown').value.trim(),
      lat: parseFloat(document.getElementById('fLat').value) || 0,
      lon: parseFloat(document.getElementById('fLon').value) || 0,
      status: document.getElementById('fStatus').value,
      tags: document.getElementById('fTags').value.split(',').map((s) => s.trim()).filter(Boolean),
      notes: document.getElementById('fNotes').value.trim(),
    };
    if (id) Object.assign(farmById(id), data);
    else state.farms.push({ id: 'f' + Date.now().toString(36), ...data });
    closeModal(); render(); toast('Сохранено');
  };
}

/* ============================= НАСТРОЙКИ =============================== */
function loadSettingsForm() {
  const s = state.settings;
  document.getElementById('setTargetPrice').value = s.targetPrice;
  document.getElementById('setMaxHum').value = s.norms.maxHumidity;
  document.getElementById('setMaxImp').value = s.norms.maxImpurity;
  document.getElementById('setMinOil').value = s.norms.minOil;
  document.getElementById('setPlantLat').value = s.plant.lat;
  document.getElementById('setPlantLon').value = s.plant.lon;
  document.getElementById('setBands').value = s.bands.join(', ');
}
function saveSettings() {
  const s = state.settings;
  s.targetPrice = parseFloat(document.getElementById('setTargetPrice').value) || s.targetPrice;
  s.norms.maxHumidity = parseFloat(document.getElementById('setMaxHum').value);
  s.norms.maxImpurity = parseFloat(document.getElementById('setMaxImp').value);
  s.norms.minOil = parseFloat(document.getElementById('setMinOil').value);
  s.plant.lat = parseFloat(document.getElementById('setPlantLat').value);
  s.plant.lon = parseFloat(document.getElementById('setPlantLon').value);
  s.bands = document.getElementById('setBands').value.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  render(); toast('Настройки сохранены');
}

/* ============================== РОУТИНГ ================================ */
function switchView(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.add('is-hidden'));
  document.getElementById('view-' + view).classList.remove('is-hidden');
  if (view === 'settings') loadSettingsForm();
}

/* =============================== СОБЫТИЯ =============================== */
function bind() {
  document.getElementById('tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (t) switchView(t.dataset.view);
  });
  document.getElementById('btnLaunch').onclick = launchSurvey;
  document.getElementById('btnSimulate').onclick = simulateResponses;
  document.getElementById('btnAddFarm').onclick = () => openFarmModal(null);
  document.getElementById('btnSaveSettings').onclick = saveSettings;
  document.getElementById('btnResetData').onclick = () => {
    if (confirm('Сбросить все данные и вернуть демо?')) { state = freshState(); render(); loadSettingsForm(); toast('Демо-данные восстановлены'); }
  };

  document.getElementById('tableSearch').addEventListener('input', renderTable);
  document.getElementById('tableFilter').addEventListener('change', renderTable);
  document.getElementById('farmSearch').addEventListener('input', renderFarms);

  document.querySelectorAll('#offersTable th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; }
      renderTable();
    });
  });

  // делегирование кнопок в таблицах
  document.getElementById('main').addEventListener('click', (e) => {
    const er = e.target.closest('[data-edit-resp]'); if (er) return openResponseModal(er.dataset.editResp);
    const ef = e.target.closest('[data-edit-farm]'); if (ef) return openFarmModal(ef.dataset.editFarm);
    const tf = e.target.closest('[data-toggle-farm]');
    if (tf) { const f = farmById(tf.dataset.toggleFarm); f.status = f.status === 'active' ? 'inactive' : 'active'; render(); }
  });

  document.getElementById('modalClose').onclick = closeModal;
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.hasAttribute('data-close')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

bind();
render();
