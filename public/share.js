// public/share.js - publiczny widok tylko do odczytu. Token jest w hashu URL, wiec nie trafia do logow serwera.
import { api, $, el, clear, td, fmtPln, fmtK, fmtPct, fmtSigned, fmtDateTime, signClass } from './ui.js';
import { lineChart, seriesMeta } from './charts.js';
import { t, applyStatic, languageSwitcher } from './i18n.js';

function card(key, value, sub, cls = '') {
  return el('div', { class: 'card' }, [
    el('div', { class: 'k', text: key }),
    el('div', { class: `v ${cls}`, text: value }),
    sub ? el('div', { class: 's', text: sub }) : null,
  ]);
}

let payload = null;

async function boot() {
  applyStatic();
  $('#lang-switch').append(languageSwitcher(() => {
    applyStatic();
    if (payload) renderAll(payload);
  }));

  const token = window.location.hash.replace(/^#/, '').trim();
  if (!token) {
    $('#banners').append(el('div', { class: 'banner', text: t('share.missingToken') }));
    $('#as-of').textContent = '';
    return;
  }

  try {
    payload = await api(`/share/${encodeURIComponent(token)}`, { redirectOn401: false });
  } catch (err) {
    $('#banners').append(el('div', { class: 'banner', text: t('share.invalid', { error: err.message }) }));
    $('#as-of').textContent = '';
    return;
  }
  renderAll(payload);
}

/** Caly render jest funkcja danych - przelaczenie jezyka wywoluje go ponownie. */
function renderAll(data) {
  $('#title').textContent = data.label || t('share.title');
  $('#as-of').textContent = t('share.asOf', { time: fmtDateTime(data.asOf) });

  const sum = data.totals;
  const p = data.performance ?? {};
  clear($('#cards')).append(
    card(t('card.totalValue'), fmtPln(sum.totalPln)),
    card(t('card.invested'), fmtPln(sum.investedPln)),
    card(t('card.cash'), fmtPln(sum.cashPln)),
    card(t('card.day'), p.day ? fmtSigned(p.day.pln) : '-', p.day ? fmtPct(p.day.pct) : '', signClass(p.day?.pln)),
    card(t('card.mtd'), p.mtd ? fmtSigned(p.mtd.pln) : '-', p.mtd ? fmtPct(p.mtd.pct) : '', signClass(p.mtd?.pln)),
    card(t('card.ytd'), p.ytd ? fmtSigned(p.ytd.pln) : '-', p.ytd ? fmtPct(p.ytd.pct) : '', signClass(p.ytd?.pln)),
    card(t('card.top5'), fmtPct(sum.top5Pct, { sign: false })),
  );

  const history = (data.history ?? []).slice(-366).map((point) => ({ day: point.day, value: point.totalPln }));
  clear($('#chart-value')).append(lineChart(history, { format: (v) => `${Math.round(v / 1000)}k` }));
  const meta = seriesMeta(history);
  const metaHost = clear($('#meta-value'));
  if (meta) {
    for (const [label, value] of [
      [t('meta.range'), `${meta.from} - ${meta.to}`],
      [t('meta.max'), `${fmtPln(meta.maxValue)} (${meta.maxDay})`],
      [t('meta.change'), fmtSigned(meta.change)],
    ]) metaHost.append(el('span', {}, [`${label}: `, el('b', { text: value })]));
  }

  const portfoliosPanel = $('#panel-portfolios');
  portfoliosPanel.classList.remove('hidden');
  if ((data.portfolios ?? []).length > 1) {
    const host = clear($('#portfolios'));
    for (const portfolio of data.portfolios) {
      host.append(el('div', { class: 'sector-row' }, [
        el('span', { class: 'nowrap' }, [
          el('span', { class: 'pf-tag' }, [el('span', { class: 'dot', style: `background:${portfolio.color}` }), portfolio.name]),
        ]),
        el('div', { class: 'bar' }, [el('i', { style: `width:${Math.max(1, portfolio.weightPct).toFixed(1)}%` })]),
        el('span', { class: 'right muted', text: fmtPln(portfolio.totalPln) }),
      ]));
    }
  } else {
    portfoliosPanel.classList.add('hidden');
  }

  const sectors = clear($('#sectors'));
  for (const item of data.sectors ?? []) {
    sectors.append(el('div', { class: 'sector-row' }, [
      el('span', { class: 'nowrap', text: item.sector }),
      el('div', { class: 'bar' }, [el('i', { style: `width:${Math.max(1, item.pct).toFixed(1)}%` })]),
      el('span', { class: 'right muted', text: fmtPct(item.pct, { sign: false, decimals: 1 }) }),
    ]));
  }

  const body = clear($('#tbl-positions tbody'));
  for (const position of data.positions ?? []) {
    body.append(el('tr', {}, [
      el('td', { class: 'left' }, [el('span', { class: 'trunc', title: `${position.name} (${position.symbol})`, text: position.name })]),
      td(fmtK(position.valuePln)),
      td(fmtPct(position.dayPct), { cls: signClass(position.dayPct) }),
      td(`${fmtK(position.pnlPln)} / ${fmtPct(position.pnlPct)}`, { cls: signClass(position.pnlPln) }),
      td(fmtPct(position.weight, { sign: false, decimals: 1 })),
      el('td', { class: 'left', text: position.sector }),
    ]));
  }
}

boot();
