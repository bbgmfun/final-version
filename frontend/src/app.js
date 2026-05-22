/**
 * Aurora Stays — Hotel Booking SPA
 * Vanilla JS single-page app talking to the API gateway.
 */

function metaContent(name) {
  const el = document.querySelector(`meta[name="${name}"]`);
  return el ? el.content.trim() : '';
}

const API_BASE = (() => {
  const override = metaContent('api-base');
  if (override) return override;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return 'http://localhost:8080';
  }
  return location.origin.replace(/:\d+$/, ':8080');
})();

/* ---------- Entra ID / MSAL ---------- */
const ENTRA_CLIENT_ID = metaContent('entra-client-id');
const ENTRA_TENANT_ID = metaContent('entra-tenant-id');
const LOGIN_SCOPES = ['openid', 'profile', 'email'];

const msalConfig = {
  auth: {
    clientId: ENTRA_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}`,
    redirectUri: window.location.origin
  },
  cache: { cacheLocation: 'sessionStorage', storeAuthStateInCookie: false }
};
let msalInstance = null;

const state = {
  user: null,
  lastSearch: null,
  recentSearches: [],
  chatSession: {},
  route: { name: 'search', params: {} }
};

/* ---------- Icons ---------- */
const ICON = {
  pin: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  map: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>'
};

async function getToken() {
  if (!msalInstance) return null;
  const account = msalInstance.getActiveAccount();
  if (!account) return null;
  try {
    const r = await msalInstance.acquireTokenSilent({ scopes: LOGIN_SCOPES, account });
    return r.idToken;
  } catch {
    try {
      const r = await msalInstance.acquireTokenPopup({ scopes: LOGIN_SCOPES });
      return r.idToken;
    } catch {
      return null;
    }
  }
}

/* ---------- HTTP ---------- */
async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const canRetry = method === 'GET';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
      let data = null;
      try { data = await res.json(); } catch {}
      if (res.ok) return data;
      if (canRetry && attempt === 0 && [502, 503, 504].includes(res.status)) {
        await wait(700);
        continue;
      }
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    } catch (err) {
      if (canRetry && attempt === 0) {
        await wait(700);
        continue;
      }
      throw err;
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------- Auth ---------- */
async function refreshUser() {
  if (!msalInstance || !msalInstance.getActiveAccount()) {
    state.user = null;
    renderAuth();
    return;
  }
  try {
    const data = await api('/v1/auth/me');
    state.user = data.user;
  } catch {
    state.user = null;
  }
  renderAuth();
}

async function doLogin() {
  try {
    const result = await msalInstance.loginPopup({ scopes: LOGIN_SCOPES, prompt: 'select_account' });
    msalInstance.setActiveAccount(result.account);
    await refreshUser();
    render();
  } catch (err) {
    alert('Giriş başarısız: ' + (err && err.message ? err.message : err));
  }
}

async function doLogout() {
  const account = msalInstance.getActiveAccount();
  state.user = null;
  renderAuth();
  render();
  try {
    await msalInstance.logoutPopup({ account, mainWindowRedirectUri: window.location.origin });
  } catch { /* popup closed */ }
}

function renderAuth() {
  const who = document.getElementById('who');
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  if (state.user) {
    who.textContent = `${state.user.email}${state.user.role === 'admin' ? ' · admin' : ''}`;
    loginBtn.hidden = true;
    logoutBtn.hidden = false;
  } else {
    who.textContent = '';
    loginBtn.hidden = false;
    logoutBtn.hidden = true;
  }
}

/* ---------- Router ---------- */
function navigate(name, params = {}) {
  state.route = { name, params };
  window.scrollTo({ top: 0, behavior: 'smooth' });
  render();
}

function render() {
  const root = document.getElementById('app');
  switch (state.route.name) {
    case 'search': return renderSearch(root);
    case 'detail': return renderDetail(root, state.route.params.hotelId);
    case 'admin': return renderAdmin(root);
    case 'reservations': return renderReservations(root);
    case 'notifications': return renderNotifications(root);
    case 'recent': return renderRecent(root);
    default: return renderSearch(root);
  }
}

/* ---------- Search ---------- */
function renderSearch(root) {
  const inAWeek = new Date(Date.now() + 7 * 86400000);
  const inTenDays = new Date(Date.now() + 10 * 86400000);
  const d = state.lastSearch || {
    destination: 'Bodrum', start: ymd(inAWeek), end: ymd(inTenDays), guests: 2
  };

  root.innerHTML = `
    <section class="search-hero">
      <h1>Bir sonraki konaklamanı bul</h1>
      <div class="sub">Şehir, tarih ve misafir sayısını seç — uygun otelleri anında listeleyelim.</div>
      <form id="searchForm" class="search-bar">
        <label>Varış noktası
          <input name="destination" value="${esc(d.destination)}" placeholder="Şehir, ülke" />
        </label>
        <label>Giriş tarihi
          <input name="start" type="date" value="${d.start}" />
        </label>
        <label>Çıkış tarihi
          <input name="end" type="date" value="${d.end}" />
        </label>
        <label>Misafir
          <input name="guests" type="number" min="1" max="10" value="${d.guests}" />
        </label>
        <button class="btn btn-primary">Ara</button>
      </form>
    </section>
    ${exampleSearchesHtml()}
    ${state.user ? '' : `
    <div class="discount-banner">
      <span>Giriş yaptığında tüm fiyatlarda otomatik %15 üye indirimi uygulanır.</span>
      <button class="btn btn-primary" id="bannerLogin">Giriş yap</button>
    </div>`}
    <div id="searchResults"></div>
  `;

  document.getElementById('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const params = Object.fromEntries(new FormData(e.target).entries());
    params.guests = Number(params.guests);
    state.lastSearch = params;
    await doSearch(params);
  });
  const bl = document.getElementById('bannerLogin');
  if (bl) bl.addEventListener('click', doLogin);
  root.querySelectorAll('[data-example-search]').forEach((button) => {
    button.addEventListener('click', async (e) => {
      const p = { ...e.currentTarget.dataset };
      const params = {
        destination: p.destination,
        start: p.start,
        end: p.end,
        guests: Number(p.guests || 2)
      };
      const form = document.getElementById('searchForm');
      form.destination.value = params.destination;
      form.start.value = params.start;
      form.end.value = params.end;
      form.guests.value = params.guests;
      state.lastSearch = params;
      await doSearch(params);
    });
  });

  doSearch(d);
}

function exampleSearchesHtml() {
  const groups = [
    { city: 'Bodrum', destination: 'Bodrum', guests: 2, ranges: [[7, 3], [24, 4], [48, 3]] },
    { city: 'Rome', destination: 'Rome', guests: 2, ranges: [[10, 3], [31, 4], [58, 3]] },
    { city: 'İstanbul', destination: 'Istanbul', guests: 2, ranges: [[14, 2], [36, 3], [65, 4]] },
    { city: 'İzmir', destination: 'Izmir', guests: 2, ranges: [[17, 3], [43, 4], [72, 3]] }
  ];
  return `<section class="sample-searches">
    <div class="sample-title">Örnek aramalar</div>
    <div class="sample-grid">
      ${groups.map((g) => `<div class="sample-city">
        <span>${esc(g.city)}</span>
        ${g.ranges.map(([offset, nights]) => {
          const start = ymd(addDays(offset));
          const end = ymd(addDays(offset + nights));
          return `<button class="sample-chip" data-example-search
            data-destination="${esc(g.destination)}" data-start="${start}" data-end="${end}" data-guests="${g.guests}">
            ${formatShortDate(start)} - ${formatShortDate(end)}
          </button>`;
        }).join('')}
      </div>`).join('')}
    </div>
  </section>`;
}

function skeletonList(n = 3) {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += `<div class="skeleton-card">
      <div class="sk sk-img"></div>
      <div style="flex:1">
        <div class="sk sk-line" style="width:55%;height:18px"></div>
        <div class="sk sk-line" style="width:35%"></div>
        <div class="sk sk-line" style="width:70%"></div>
        <div class="sk sk-line" style="width:25%;margin-top:1.2rem"></div>
      </div>
    </div>`;
  }
  return s;
}

async function doSearch(params) {
  const el = document.getElementById('searchResults');
  el.innerHTML = `<div class="results">
    <div class="map-side"><div class="sk" style="height:460px;border-radius:14px"></div></div>
    <div>${skeletonList(3)}</div>
  </div>`;
  try {
    const qs = new URLSearchParams({
      destination: params.destination,
      start: new Date(params.start).toISOString(),
      end: new Date(params.end).toISOString(),
      guests: String(params.guests)
    }).toString();
    const data = await api(`/v1/search?${qs}`);
    renderResults(el, data);
    // persist last search and recent searches (localStorage)
    try {
      state.lastSearch = params;
      const rs = JSON.parse(localStorage.getItem('recentSearches') || '[]');
      const entry = { destination: params.destination, start: params.start, end: params.end, guests: params.guests };
      // dedupe by JSON
      const key = JSON.stringify(entry);
      const filtered = rs.filter((r) => JSON.stringify(r) !== key);
      filtered.unshift(entry);
      const limited = filtered.slice(0, 8);
      localStorage.setItem('recentSearches', JSON.stringify(limited));
      state.recentSearches = limited;
    } catch (e) { /* ignore storage errors */ }
  } catch (err) {
    el.innerHTML = `<div class="panel"><div class="empty">
      <div class="empty-title">Arama yapılamadı</div>${esc(err.message)}</div></div>`;
  }
}

function renderRecent(root) {
  const rs = state.recentSearches && state.recentSearches.length ? state.recentSearches : (JSON.parse(localStorage.getItem('recentSearches') || '[]'));
  root.innerHTML = `<h1>Son Aramalarım</h1>
    <div class="panel">
      ${rs.length ? rs.map((r, i) => `
        <div class="recent-item">
          <div><strong>${esc(r.destination)}</strong> · ${ymd(r.start)} → ${ymd(r.end)} · ${r.guests} misafir</div>
          <div><button class="btn" data-run="${i}">Tekrar Ara</button></div>
        </div>
      `).join('') : '<div class="muted">Henüz arama yok.</div>'}
    </div>`;
  root.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', (e) => {
    const i = Number(e.currentTarget.dataset.run);
    const entry = rs[i];
    if (entry) {
      state.lastSearch = entry;
      doSearch(entry);
      navigate('search');
    }
  }));
}

function renderResults(el, data) {
  if (!data.items.length) {
    el.innerHTML = `<div class="panel"><div class="empty">
      <div class="empty-title">Sonuç bulunamadı</div>
      Bu tarihlerde uygun oda yok. Tarihleri ya da şehri değiştirip tekrar dene.</div></div>`;
    return;
  }
  el.innerHTML = `
    <div class="results">
      <div class="map-side">
        <div class="map-header">${ICON.map} Haritada göster</div>
        <div id="map"></div>
      </div>
      <div class="list-side">
        <div class="results-count">${data.total} konaklama yeri · ${data.nights} gece</div>
        ${data.items.map((h, i) => hotelCardHtml(h, i)).join('')}
      </div>
    </div>`;

  const points = data.items.filter((h) => h.location && h.location.lat);
  const center = points[0] ? [points[0].location.lat, points[0].location.lng] : [37.0344, 27.4305];
  const map = L.map('map', { scrollWheelZoom: false }).setView(center, 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  for (const p of points) {
    L.marker([p.location.lat, p.location.lng]).addTo(map)
      .bindPopup(`<b>${esc(p.name)}</b><br/>${esc(p.city)}<br/>${Math.round(p.displayPricePerNight)} TL/gece`);
  }

  el.querySelectorAll('[data-hotel-id]').forEach((card) => {
    card.addEventListener('click', () => navigate('detail', { hotelId: card.dataset.hotelId }));
  });
}

function hotelCardHtml(h, i) {
  const showOriginal = h.discount > 0;
  const rating = Number(h.rating || 0);
  const isHigh = rating >= 8 || (rating <= 5 && rating >= 4);
  const amenities = (h.amenities || []).slice(0, 4)
    .map((a) => `<span class="chip">${esc(a)}</span>`).join('');
  return `
    <article class="hotel-card" data-hotel-id="${esc(h.hotelId)}" style="animation-delay:${i * 70}ms">
      <img src="${esc(h.imageUrl) || 'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=420'}"
           alt="${esc(h.name)}" loading="lazy" />
      <div class="meta">
        <h3>${esc(h.name)}</h3>
        <div class="city">${ICON.pin} ${esc(h.city)}, ${esc(h.country)}</div>
        <div class="amenities">${amenities}</div>
        <div class="rating-row">
          <span class="score ${isHigh ? 'high' : ''}">${rating.toFixed(1)}</span>
          <span class="score-label">${isHigh ? 'Mükemmel' : 'İyi'}</span>
        </div>
      </div>
      <div class="price">
        ${showOriginal ? `<div class="original">${Math.round(h.basePricePerNight)} TL</div>` : ''}
        <div class="final">${Math.round(h.displayPricePerNight)} TL</div>
        <div class="per">gece başına</div>
        <button class="btn btn-primary">İncele</button>
      </div>
    </article>`;
}

/* ---------- Detail ---------- */
async function renderDetail(root, hotelId) {
  root.innerHTML = `<div class="loading"><span class="spinner"></span></div>`;
  try {
    // The hotel detail is required; comments are best-effort so the page
    // still loads if the comments service is briefly unavailable.
    const detail = await api(`/v1/hotels/${hotelId}`);
    let summary = { total: 0, overall: detail.rating || 0, breakdown: [] };
    let comments = { items: [] };
    try { summary = await api(`/v1/hotels/${hotelId}/comments/summary`); } catch {}
    try { comments = await api(`/v1/hotels/${hotelId}/comments?page=1&pageSize=5`); } catch {}
    const firstRoom = detail.rooms && detail.rooms[0];
    root.innerHTML = `
      <button class="btn" id="backBtn">&larr; Aramaya dön</button>
      <div class="detail-grid">
        <div>
          <img class="detail-hero" src="${esc(detail.imageUrl)}" alt="${esc(detail.name)}" />
          <h1 style="margin-top:1rem">${esc(detail.name)}</h1>
          <div class="muted" style="display:flex;align-items:center;gap:.35rem">
            ${ICON.pin} ${esc(detail.city)}, ${esc(detail.country)}
          </div>
          <p style="color:var(--ink-soft);line-height:1.6">${esc(detail.description)}</p>

          <div class="panel">
            <h2>${(summary.overall || detail.rating || 0)} / 10 — Misafir değerlendirmeleri</h2>
            <div class="muted" style="margin-bottom:1rem">${summary.total} doğrulanmış yorum</div>
            <div class="bars">
              ${summary.breakdown.map((b) => `
                <div class="bar-row">
                  <span>${esc(b.service)}</span>
                  <span class="bar"><div data-w="${(b.average / 10) * 100}"></div></span>
                  <span class="val">${b.average}</span>
                </div>`).join('')}
            </div>
          </div>

          <div class="panel">
            <h2>Yorumlar</h2>
            ${comments.items.length ? comments.items.map((c) => `
              <div class="comment">
                <div class="name">${esc(c.userName)}</div>
                <div class="comment-meta">${c.overall}/10 · ${esc(c.tripType || 'Konaklama')} · ${new Date(c.createdAt).toLocaleDateString('tr-TR')}</div>
                <div class="body">${esc(c.body)}</div>
              </div>`).join('') : '<div class="muted">Henüz yorum yok.</div>'}
            ${state.user ? renderCommentForm() : '<p class="muted" style="margin-top:1rem">Yorum yazmak için giriş yapın.</p>'}
          </div>
        </div>

        <aside>
          <div class="book-card">
            ${detail.loggedIn ? `<div class="badge-member">Üye fiyatı · %${Math.round(detail.discount * 100)} indirim</div>` : ''}
            <div class="price-big">${firstRoom ? Math.round(firstRoom.displayPricePerNight) : '—'} TL</div>
            <div class="muted" style="font-size:.8rem">gece başına · vergiler dâhil</div>
            <form id="bookForm" style="margin-top:1rem">
              <div class="field">
                <label>Oda tipi</label>
                <select name="roomType">
                  ${(detail.rooms || []).map((r) => `<option value="${esc(r.roomType)}">${esc(r.roomType)} — ${Math.round(r.displayPricePerNight)} TL</option>`).join('')}
                </select>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem">
                <div class="field"><label>Giriş</label><input name="startDate" type="date" value="${ymd(addDays(7))}" /></div>
                <div class="field"><label>Çıkış</label><input name="endDate" type="date" value="${ymd(addDays(10))}" /></div>
              </div>
              <div class="field"><label>Misafir</label><input name="guests" type="number" value="2" min="1" max="6" /></div>
              <button class="btn btn-primary" style="width:100%;margin-top:1rem">Rezervasyon yap</button>
              <p id="bookMsg" class="error"></p>
            </form>
          </div>
        </aside>
      </div>`;

    // animate rating bars
    requestAnimationFrame(() => {
      root.querySelectorAll('.bar-row .bar > div').forEach((d) => {
        d.style.width = (d.dataset.w || 0) + '%';
      });
    });

    document.getElementById('backBtn').addEventListener('click', () => navigate('search'));
    document.getElementById('bookForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.user) { doLogin(); return; }
      const fd = Object.fromEntries(new FormData(e.target).entries());
      const msg = document.getElementById('bookMsg');
      const btn = e.target.querySelector('button');
      btn.disabled = true; btn.textContent = 'İşleniyor...';
      try {
        const r = await api(`/v1/hotels/${hotelId}/book`, {
          method: 'POST',
          body: {
            roomType: fd.roomType,
            startDate: new Date(fd.startDate).toISOString(),
            endDate: new Date(fd.endDate).toISOString(),
            guests: Number(fd.guests)
          }
        });
        msg.className = 'ok-msg';
        msg.textContent = `Rezervasyon onaylandı. No: ${r._id} · ${r.totalPrice} TL`;
      } catch (err) {
        msg.className = 'error';
        msg.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Rezervasyon yap';
      }
    });

    const cf = document.getElementById('commentForm');
    if (cf) cf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target).entries());
      try {
        await api(`/v1/hotels/${hotelId}/comments`, {
          method: 'POST',
          body: {
            body: fd.body, overall: Number(fd.overall), tripType: fd.tripType,
            serviceRatings: {
              'Temizlik': Number(fd.r1), 'Personel ve servis': Number(fd.r2),
              'İmkân ve özellikler': Number(fd.r3), 'Konaklama yeri': Number(fd.r4),
              'Çevre dostluğu': Number(fd.r5)
            }
          }
        });
        renderDetail(root, hotelId);
      } catch (err) { alert(err.message); }
    });
  } catch (err) {
    root.innerHTML = `<div class="panel"><div class="empty">
      <div class="empty-title">Otel yüklenemedi</div>${esc(err.message)}</div></div>`;
  }
}

function renderCommentForm() {
  return `
    <form id="commentForm" class="panel" style="margin-top:1rem;background:var(--surface-2)">
      <h2>Yorum bırak</h2>
      <div class="field">
        <label>Yorumunuz</label>
        <textarea name="body" rows="3" required style="font-family:var(--font);font-size:.9rem;padding:.55rem .7rem;border:1px solid var(--border-strong);border-radius:9px;resize:vertical"></textarea>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem">
        <div class="field"><label>Genel puan (0-10)</label><input name="overall" type="number" min="0" max="10" step="0.1" value="8.5" /></div>
        <div class="field"><label>Seyahat türü</label><input name="tripType" placeholder="3 gecelik tatil" /></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:.5rem">
        <div class="field"><label>Temizlik</label><input name="r1" type="number" min="0" max="10" step="0.1" value="9" /></div>
        <div class="field"><label>Personel</label><input name="r2" type="number" min="0" max="10" step="0.1" value="9" /></div>
        <div class="field"><label>İmkânlar</label><input name="r3" type="number" min="0" max="10" step="0.1" value="9" /></div>
        <div class="field"><label>Konaklama</label><input name="r4" type="number" min="0" max="10" step="0.1" value="9" /></div>
        <div class="field"><label>Çevre</label><input name="r5" type="number" min="0" max="10" step="0.1" value="9" /></div>
      </div>
      <button class="btn btn-primary" style="margin-top:.8rem">Gönder</button>
    </form>`;
}

/* ---------- Admin ---------- */
async function renderAdmin(root) {
  if (!state.user || state.user.role !== 'admin') {
    root.innerHTML = `<div class="panel"><div class="empty">
      <div class="empty-title">Admin yetkisi gerekli</div>
      Microsoft hesabınızla giriş yapın. Admin yetkisi yapılandırılan e-posta listesine verilir.</div></div>`;
    return;
  }
  const hotelId = (state.user.hotelIds && state.user.hotelIds[0]) || 'hotel-swiss';
  root.innerHTML = `<div class="loading"><span class="spinner"></span></div>`;
  try {
    const rooms = await api(`/v1/admin/hotels/${hotelId}/rooms`);
    root.innerHTML = `
      <h1>Otel yönetimi <span class="muted" style="font-size:1rem">· ${esc(hotelId)}</span></h1>
      <div class="panel">
        <h2>Oda kontenjanı ekle</h2>
        <form id="roomForm" class="admin-form">
          <div class="field"><label>Başlangıç</label><input name="startDate" type="date" required /></div>
          <div class="field"><label>Bitiş</label><input name="endDate" type="date" required /></div>
          <div class="field"><label>Oda tipi</label>
            <select name="roomType"><option>Standard</option><option>Aile</option><option>Deluxe</option><option>Suite</option></select>
          </div>
          <div class="field"><label>Oda adedi</label><input name="totalRooms" type="number" min="0" value="5" /></div>
          <div class="field"><label>Fiyat (TL/gece)</label><input name="pricePerNight" type="number" min="0" value="12000" /></div>
          <div class="field"><label>Durum</label>
            <select name="status"><option>Bos</option><option>Dolu</option></select>
          </div>
          <button class="btn btn-primary full">Kontenjanı kaydet</button>
          <p id="adminMsg" class="ok-msg full"></p>
        </form>
      </div>
      <div class="panel">
        <h2>Mevcut kontenjanlar</h2>
        <table class="admin-rooms">
          <thead><tr><th>Oda tipi</th><th>Başlangıç</th><th>Bitiş</th><th>Toplam</th><th>Müsait</th><th>Fiyat</th><th>Durum</th></tr></thead>
          <tbody>
            ${rooms.items.length ? rooms.items.map((r) => `
              <tr>
                <td>${esc(r.roomType)}</td>
                <td>${ymd(r.startDate)}</td>
                <td>${ymd(r.endDate)}</td>
                <td>${r.totalRooms}</td>
                <td>${r.availableRooms}</td>
                <td>${r.pricePerNight} TL</td>
                <td><span class="pill ${r.status === 'Bos' ? 'bos' : 'dolu'}">${esc(r.status)}</span></td>
              </tr>`).join('') : '<tr><td colspan="7" class="muted">Henüz kontenjan yok.</td></tr>'}
          </tbody>
        </table>
      </div>`;

    document.getElementById('roomForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target).entries());
      const msg = document.getElementById('adminMsg');
      try {
        await api(`/v1/admin/hotels/${hotelId}/rooms`, {
          method: 'POST',
          body: {
            roomType: fd.roomType,
            startDate: new Date(fd.startDate).toISOString(),
            endDate: new Date(fd.endDate).toISOString(),
            totalRooms: Number(fd.totalRooms),
            pricePerNight: Number(fd.pricePerNight),
            status: fd.status
          }
        });
        msg.className = 'ok-msg full'; msg.textContent = 'Kontenjan kaydedildi.';
        setTimeout(() => renderAdmin(root), 700);
      } catch (err) {
        msg.className = 'error full'; msg.textContent = err.message;
      }
    });
  } catch (err) {
    root.innerHTML = `<div class="panel"><div class="empty">${esc(err.message)}</div></div>`;
  }
}

/* ---------- Reservations / Notifications ---------- */
async function renderReservations(root) {
  if (!state.user) {
    root.innerHTML = `<div class="panel"><div class="empty"><div class="empty-title">Giriş gerekli</div>Rezervasyonlarınızı görmek için giriş yapın.</div></div>`;
    return;
  }
  root.innerHTML = `<div class="loading"><span class="spinner"></span></div>`;
  try {
    const r = await api('/v1/reservations');
    root.innerHTML = `<h1>Rezervasyonlarım</h1>
      <div class="panel">
        ${r.items.length ? r.items.map((x) => `
          <div class="comment">
            <div class="name">${esc(x.hotelId)} · ${esc(x.roomType)}</div>
            <div class="comment-meta">${ymd(x.startDate)} → ${ymd(x.endDate)} · ${x.guests} misafir</div>
            <div class="body">${x.totalPrice} TL · ${esc(x.status)}</div>
          </div>`).join('') : '<div class="empty">Henüz rezervasyonunuz yok.</div>'}
      </div>`;
  } catch (err) {
    root.innerHTML = `<div class="panel"><div class="empty">${esc(err.message)}</div></div>`;
  }
}

async function renderNotifications(root) {
  if (!state.user) {
    root.innerHTML = `<div class="panel"><div class="empty"><div class="empty-title">Giriş gerekli</div>Bildirimleri görmek için giriş yapın.</div></div>`;
    return;
  }
  root.innerHTML = `<div class="loading"><span class="spinner"></span></div>`;
  try {
    const r = await api(`/v1/notifications?to=${encodeURIComponent(state.user.email)}&limit=20`);
    root.innerHTML = `<h1>Bildirimler</h1>
      <div class="panel">
        ${r.items.length ? r.items.map((x) => `
          <div class="comment">
            <div class="name">${esc(x.subject)}</div>
            <div class="comment-meta">${new Date(x.sentAt).toLocaleString('tr-TR')} · ${esc(x.channel)}</div>
            <div class="body" style="white-space:pre-wrap">${esc(x.body)}</div>
          </div>`).join('') : '<div class="empty">Henüz bildiriminiz yok. Bir rezervasyon yapın — Notification servisi kuyruktan mesajı alıp burada gösterecek.</div>'}
      </div>`;
  } catch (err) {
    root.innerHTML = `<div class="panel"><div class="empty">${esc(err.message)}</div></div>`;
  }
}

/* ---------- Chat ---------- */
function setupChat() {
  const toggle = document.getElementById('chatToggle');
  const panel = document.getElementById('chatPanel');
  const close = document.getElementById('chatClose');
  const form = document.getElementById('chatForm');
  const input = document.getElementById('chatInput');
  const log = document.getElementById('chatLog');

  // Guard: required elements must exist
  if (!toggle || !panel || !form || !input || !log) {
    console.warn('chat elements missing', { toggle: !!toggle, panel: !!panel, form: !!form, input: !!input, log: !!log });
    return;
  }

  // Ensure chat panel starts closed and toggle visible
  if (!panel.hasAttribute('hidden')) panel.setAttribute('hidden', '');
  toggle.removeAttribute('hidden');

  // Prevent double-initialization
  if (toggle.dataset.chatInited) return;
  toggle.dataset.chatInited = '1';

  const openChat = () => {
    panel.removeAttribute('hidden');
    toggle.setAttribute('hidden', '');
    if (!log.children.length) appendAI('Merhaba. Hangi şehir ve tarihler için otel aramamı istersiniz? Örneğin: <i>"Bodrum 12-16 Mayıs, 2 misafir, havuzlu"</i>');
    input.focus();
  };
  const closeChat = () => {
    panel.setAttribute('hidden', '');
    toggle.removeAttribute('hidden');
    toggle.focus();
  };

  toggle.addEventListener('click', () => {
    const opening = panel.hasAttribute('hidden');
    if (opening) openChat();
    else closeChat();
  });
  if (close) {
    close.addEventListener('click', closeChat);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    appendUser(text);
    input.value = '';
    const typing = appendTyping();
    try {
      const r = await api('/v1/chat', { method: 'POST', body: { message: text, session: state.chatSession } });
      state.chatSession = r.session || {};
      typing.remove();
      appendAI(r.reply);
      for (const a of (r.actions || [])) {
        if (a.type === 'hotel') appendCard(a);
        else if (a.type === 'requireLogin') { appendAI('Devam etmek için giriş yapmanız gerekiyor.'); doLogin(); }
        else if (a.type === 'reservation') appendAI(`Rezervasyon onaylandı. Onay no: ${a.reservation._id}`);
      }
      if (r.followup) appendAI(r.followup);
    } catch (err) {
      typing.remove();
      appendAI('Bir hata oluştu: ' + err.message);
    }
  });

  function scroll() { log.scrollTop = log.scrollHeight; }
  function appendUser(t) {
    const b = document.createElement('div');
    b.className = 'bubble user'; b.textContent = t;
    log.appendChild(b); scroll();
  }
  function appendAI(t) {
    const b = document.createElement('div');
    b.className = 'bubble ai'; b.innerHTML = t;
    log.appendChild(b); scroll();
  }
  function appendTyping() {
    const b = document.createElement('div');
    b.className = 'bubble ai typing';
    b.innerHTML = '<span></span><span></span><span></span>';
    log.appendChild(b); scroll();
    return b;
  }
  function appendCard(a) {
    const b = document.createElement('div');
    b.className = 'bubble ai';
    b.innerHTML = `
      <div class="bubble-card">
        <div class="card-name">${esc(a.name)}</div>
        <div class="card-line">${esc(a.city)} · ${a.rating} / 10</div>
        <div class="card-line">${Math.round(a.pricePerNight)} TL / gece</div>
        <div class="card-line">${esc((a.amenities || []).join(', '))}</div>
        <button class="btn btn-primary" data-hotel="${esc(a.hotelId)}">İncele ve rezerve et</button>
      </div>`;
    log.appendChild(b); scroll();
    b.querySelector('[data-hotel]').addEventListener('click', () => {
      try { panel.setAttribute('hidden', ''); toggle.removeAttribute('hidden'); } catch (e) { /* ignore */ }
      navigate('detail', { hotelId: a.hotelId });
    });
  }
}

/* ---------- Helpers ---------- */
function ymd(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
function addDays(n) { return new Date(Date.now() + n * 86400000); }
function formatShortDate(d) {
  return new Date(`${d}T00:00:00`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Bootstrap ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-route]');
  if (t) { e.preventDefault(); navigate(t.dataset.route); }
});

async function bootstrap() {
  if (!ENTRA_CLIENT_ID || !ENTRA_TENANT_ID) {
    console.warn('Entra ID config missing — set the meta tags in index.html');
  }
  try {
    msalInstance = new msal.PublicClientApplication(msalConfig);
    await msalInstance.initialize();
    await msalInstance.handleRedirectPromise();
    const accounts = msalInstance.getAllAccounts();
    if (accounts.length) {
      msalInstance.setActiveAccount(accounts[0]);
      await refreshUser();
    }
  } catch (err) {
    console.error('MSAL init failed', err);
  }
  // Load recent searches from localStorage (if any)
  try { state.recentSearches = JSON.parse(localStorage.getItem('recentSearches') || '[]'); } catch (e) { state.recentSearches = []; }
  setupChat();
  document.getElementById('loginBtn').addEventListener('click', doLogin);
  document.getElementById('logoutBtn').addEventListener('click', doLogout);
  renderAuth();
  render();
}

bootstrap();
