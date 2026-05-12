/* GV70 Lease Tracker — static feed-driven dashboard */
(function () {
  'use strict';

  var FEED_PATH = './feed/gv70_lease_feed.json';

  var $ = function (id) { return document.getElementById(id); };
  var money = function (n) {
    var v = Number(n);
    if (!isFinite(v)) return '$—';
    return '$' + v.toLocaleString('en-US');
  };
  var formatDate = function (iso) {
    if (!iso) return 'Unknown';
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });
    } catch (e) { return String(iso); }
  };

  var state = {
    offers: [],
    previous: [],
    changeLog: [],
    chart: null,
    theme: 'light'
  };

  function badgeClass(delta) {
    if (delta < 0) return 'down';
    if (delta > 0) return 'up';
    return 'flat';
  }
  function badgeText(delta) {
    if (delta < 0) return money(Math.abs(delta)) + ' lower';
    if (delta > 0) return money(delta) + ' higher';
    return 'No change';
  }
  function rowStatusClass(status) {
    return String(status || '').toLowerCase().indexOf('active') === 0 ? 'good' : 'warn';
  }

  function showBanner(msg) {
    var b = $('feedBanner');
    if (!b) return;
    if (msg) {
      b.textContent = msg;
      b.hidden = false;
    } else {
      b.hidden = true;
      b.textContent = '';
    }
  }

  function loadFeed() {
    showBanner('');
    return fetch(FEED_PATH, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('Feed HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.offers)) {
          throw new Error('Feed missing offers array');
        }
        $('updatedLabel').textContent = formatDate(data.meta && data.meta.updated_at);
        if (state.offers.length) {
          state.previous = JSON.parse(JSON.stringify(state.offers));
        } else {
          state.previous = JSON.parse(JSON.stringify(data.offers));
        }
        state.offers = data.offers;
        computeChanges();
        renderOffers();
        renderSourceList();
        renderStatuses();
        renderChart();
      })
      .catch(function (err) {
        console.error('Feed load error:', err);
        $('updatedLabel').textContent = 'Feed error';
        showBanner('Could not load the live feed. Showing last-known values.');
      });
  }

  function computeChanges() {
    state.offers.forEach(function (offer, i) {
      var prev = state.previous[i];
      if (!prev) return;
      var changes = [];
      if (offer.monthly_payment !== prev.monthly_payment) {
        changes.push(money((offer.monthly_payment || 0) - (prev.monthly_payment || 0)) + ' /mo');
      }
      if (offer.term_months !== prev.term_months) {
        changes.push((prev.term_months || '—') + '→' + (offer.term_months || '—') + ' mo');
      }
      if (offer.due_at_signing !== prev.due_at_signing) {
        changes.push('DAS ' + money(prev.due_at_signing) + '→' + money(offer.due_at_signing));
      }
      if (changes.length) {
        state.changeLog.unshift({
          source: offer.source,
          previous: money(prev.monthly_payment) + ' / ' + (prev.term_months || '—') + ' mo',
          current: money(offer.monthly_payment) + ' / ' + (offer.term_months || '—') + ' mo',
          delta: changes.join(' · '),
          time: new Date().toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
          })
        });
      }
    });
    $('alertCount').textContent = state.changeLog.length;
    $('lastRefresh').textContent = state.changeLog[0] ? state.changeLog[0].time : 'No changes yet';

    var tbody = $('changeLog');
    tbody.innerHTML = '';
    if (!state.changeLog.length) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="5" class="muted-row">No changes detected yet.</td>';
      tbody.appendChild(tr);
      return;
    }
    state.changeLog.slice(0, 12).forEach(function (item) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td data-label="Source">' + escapeHtml(item.source) + '</td>' +
        '<td data-label="Previous">' + escapeHtml(item.previous) + '</td>' +
        '<td data-label="Current">' + escapeHtml(item.current) + '</td>' +
        '<td data-label="Delta">' + escapeHtml(item.delta) + '</td>' +
        '<td data-label="Detected">' + escapeHtml(item.time) + '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderOffers() {
    var grid = $('offerGrid');
    grid.innerHTML = '';
    state.offers.forEach(function (o, i) {
      var prev = state.previous[i] || o;
      var delta = (o.monthly_payment || 0) - (prev.monthly_payment || 0);
      var card = document.createElement('article');
      card.className = 'card offer-card';
      card.innerHTML =
        '<h3>' + escapeHtml(o.source) + '</h3>' +
        '<div class="price-line">' +
          '<div class="price">' + money(o.monthly_payment) + '<span class="price-unit"> /mo</span></div>' +
          '<span class="pill ' + badgeClass(delta) + '">' + escapeHtml(badgeText(delta)) + '</span>' +
        '</div>' +
        '<div class="meta">' +
          '<div>' + escapeHtml((o.term_months || '—') + ' months · ' + money(o.due_at_signing) + ' due at signing') + '</div>' +
          '<div>' + escapeHtml((o.trim || '—') + ' · ' + (o.type || '—')) + '</div>' +
          '<div>' + escapeHtml(o.apr_offer || 'No APR note in feed') + '</div>' +
        '</div>' +
        '<div class="status-row">' +
          '<span class="pill note">' + escapeHtml(o.miles_per_year ? (o.miles_per_year.toLocaleString('en-US') + ' mi/yr') : 'Tap source') + '</span>' +
          (o.url ? '<a class="tap-link" href="' + escapeAttr(o.url) + '" target="_blank" rel="noopener noreferrer">Open source</a>' : '') +
        '</div>';
      grid.appendChild(card);
    });

    var official = state.offers.find(function (o) { return /Genesis/i.test(o.source); }) || state.offers[0] || {};
    var market   = state.offers.find(function (o) { return /TrueCar/i.test(o.source); }) || state.offers[1] || {};
    var lowest   = state.offers.reduce(function (a, b) {
      return (a && (a.monthly_payment || Infinity) < (b.monthly_payment || Infinity)) ? a : b;
    }, state.offers[0] || {});

    $('bestOfficial').textContent = money(official.monthly_payment);
    $('officialSub').textContent = (official.term_months || '—') + ' months · ' + money(official.due_at_signing) + ' due';
    $('marketAvg').textContent = money(market.monthly_payment);
    $('marketSub').textContent = (market.term_months || '—') + ' months reference';
    $('lowestTracked').textContent = money(lowest.monthly_payment);
    $('lowestSource').textContent = lowest.source || '—';
  }

  function renderSourceList() {
    var list = $('sourceList');
    list.innerHTML = '';
    state.offers.forEach(function (o) {
      var card = document.createElement('article');
      card.className = 'card offer-card';
      card.innerHTML =
        '<h3>' + escapeHtml(o.source) + '</h3>' +
        '<div class="meta">' +
          '<div>' + escapeHtml(o.type || '—') + '</div>' +
          '<div>' + money(o.monthly_payment) + ' / month reference</div>' +
        '</div>' +
        '<div class="status-row">' +
          '<span class="pill good">Chrome-ready</span>' +
          (o.url ? '<a class="tap-link" href="' + escapeAttr(o.url) + '" target="_blank" rel="noopener noreferrer">Open</a>' : '') +
        '</div>';
      list.appendChild(card);
    });
  }

  function renderStatuses() {
    var tbody = $('statusTable');
    tbody.innerHTML = '';
    state.offers.forEach(function (o) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td data-label="Source">' + escapeHtml(o.source) + '</td>' +
        '<td data-label="Status"><span class="pill ' + rowStatusClass(o.status) + '">' + escapeHtml(o.status || 'unknown') + '</span></td>' +
        '<td data-label="Link">' + (o.url ? '<a href="' + escapeAttr(o.url) + '" target="_blank" rel="noopener noreferrer">Link</a>' : '—') + '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderChart() {
    if (typeof Chart === 'undefined') return;
    var styles = getComputedStyle(document.documentElement);
    var muted   = styles.getPropertyValue('--color-text-muted').trim();
    var divider = styles.getPropertyValue('--color-divider').trim();
    var primary = styles.getPropertyValue('--color-primary').trim();
    var blue    = styles.getPropertyValue('--color-blue').trim();
    var success = styles.getPropertyValue('--color-success').trim();
    var purple  = styles.getPropertyValue('--color-purple').trim();
    var palette = [primary, blue, success, purple];

    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('offerChart'), {
      type: 'bar',
      data: {
        labels: state.offers.map(function (o) { return o.source; }),
        datasets: [{
          label: 'Monthly payment',
          data: state.offers.map(function (o) { return o.monthly_payment || 0; }),
          backgroundColor: state.offers.map(function (_, i) { return palette[i % palette.length]; }),
          borderRadius: 10
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (ctx) { return money(ctx.parsed.y) + ' /mo'; } } }
        },
        scales: {
          x: { ticks: { color: muted }, grid: { display: false } },
          y: { ticks: { color: muted, callback: function (v) { return '$' + v; } }, grid: { color: divider } }
        }
      }
    });
  }

  /* Buy planner */
  function updatePlanner() {
    var price = Number($('targetPrice').value || 0);
    var down  = Number($('downPayment').value || 0);
    var move  = Number($('moveReserve').value || 0);
    var month = $('targetMonth').value || 'March 2027';
    $('financedAmount').textContent = money(Math.max(0, price - down));
    $('cashTarget').textContent = money(down + move);
    $('watchWindow').textContent = 'Three months ahead of ' + month;
  }

  /* Theme */
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    var btn = $('themeToggle');
    if (btn) btn.textContent = state.theme === 'dark' ? 'Light mode' : 'Dark mode';
    if (state.offers.length) renderChart();
  }

  /* Footer-nav active state */
  function bindFooterNav() {
    var links = document.querySelectorAll('.footer-nav a');
    links.forEach(function (a) {
      a.addEventListener('click', function () {
        links.forEach(function (l) { l.classList.remove('active'); });
        a.classList.add('active');
      });
    });
  }

  /* Utils */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  /* Init */
  document.addEventListener('DOMContentLoaded', function () {
    try {
      state.theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) { state.theme = 'light'; }
    applyTheme();
    $('themeToggle').addEventListener('click', function () {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
    });
    $('refreshDeals').addEventListener('click', function () { loadFeed(); });
    ['targetPrice', 'downPayment', 'moveReserve', 'targetMonth'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('input', updatePlanner);
    });
    bindFooterNav();
    updatePlanner();
    loadFeed();
  });
})();
