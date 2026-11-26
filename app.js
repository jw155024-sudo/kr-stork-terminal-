/* KR Terminal — 국내주식 전종목 터미널
   데이터: data/market.json (전종목 요약), data/h/{코드앞2자리}.json (종목 상세)
   개인 보유·메모는 브라우저 localStorage 에만 저장됩니다. */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  const state = {
    data: null,
    byCode: new Map(),
    tab: "all",
    market: "ALL",
    fMin: 0,        // 외국인 연속 순매수 최소 일수 (0 = 전체)
    oMin: 0,        // 기관 연속 순매수 최소 일수
    pMin: 0,        // 주가 연속 상승 최소 일수
    rMin: 0,        // 전일 상승률 최소 %
    chart: "",      // "" | b60 | b120 | a60 | a120
    perMax: 1.5,    // 추세·저PER 탭 PER 상한(배, 적자 제외)
    trend: "both",  // 추세·저PER 탭 추세 조건: both | b60 | b120 | above
    both: false,    // 외인+기관 쌍끌이
    q: "",
    sort: { key: "va", dir: -1 },
    limit: 120,
    watch: new Set(LS.get("krt.watch", [])),
    holdings: LS.get("krt.hold", {}),
    notes: LS.get("krt.note", {}),
    hcache: new Map(),
    openCode: null
  };

  /* ─────────────────────────── 숫자 서식 ─────────────────────────── */
  const nf = new Intl.NumberFormat("ko-KR");
  const fmt = (n, d = 0) => (n === null || n === undefined || isNaN(n)) ? "–"
    : (d ? Number(n).toFixed(d) : nf.format(Math.round(n)));

  function won(n) { // 금액 → 조/억/만
    if (n === null || n === undefined || isNaN(n)) return "–";
    const a = Math.abs(n), s = n < 0 ? "-" : "";
    if (a >= 1e12) return s + (a / 1e12).toFixed(a >= 1e13 ? 1 : 2) + "조";
    if (a >= 1e8) return s + Math.round(a / 1e8).toLocaleString("ko-KR") + "억";
    if (a >= 1e4) return s + Math.round(a / 1e4).toLocaleString("ko-KR") + "만";
    return s + Math.round(a).toLocaleString("ko-KR");
  }
  function qty(n) {
    if (n === null || n === undefined || isNaN(n)) return "–";
    const a = Math.abs(n), s = n < 0 ? "-" : "+";
    if (a >= 1e8) return s + (a / 1e8).toFixed(1) + "억주";
    if (a >= 1e4) return s + Math.round(a / 1e4).toLocaleString("ko-KR") + "만주";
    return s + nf.format(Math.round(n));
  }
  function signedTxt(v, d = 2, suffix = "%") {
    if (v === null || v === undefined || isNaN(v)) return "–";
    return (v > 0 ? "+" : "") + Number(v).toFixed(d) + suffix;
  }
  const cls = v => v === null || v === undefined || isNaN(v) ? "flat" : v > 0 ? "up" : v < 0 ? "down" : "flat";
  const chAmt = s => s.ch != null ? (s.ch > 0 ? "+" : "") + nf.format(s.ch) : "–";

  /* ─────────────────────────── 로드 ─────────────────────────── */
  async function boot() {
    try {
      const res = await fetch("data/market.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const d = await res.json();
      state.data = d;
      d.stocks.forEach(s => state.byCode.set(s.c, s));
      renderStrip();
      renderStamp();
      updateCounts();
      renderTable();
      $("#srcline").insertAdjacentHTML("afterbegin", "");
    } catch (e) {
      $("#tinfo").innerHTML = '<span class="down">데이터를 불러오지 못했습니다 — ' + e.message + "</span>";
      $("#stamp").textContent = "오프라인";
    }
  }

  function updateCounts() {
    const d = state.data;
    if (!d) return;
    const st = d.stocks;
    $("#cntAll").textContent = nf.format(st.length);
    $("#cntFor").textContent = nf.format(st.filter(s => s.fq > 0 || s.fv > 0).length);
    $("#cntInst").textContent = nf.format(st.filter(s => s.oq > 0 || s.oc > 0).length);
    $("#cntRose").textContent = nf.format(st.filter(s => s.pchp > 0).length);
    $("#cntPer").textContent = nf.format(st.filter(s => hasLowPer(s, "both", 1.5)).length);
    $("#cntMine").textContent = state.watch.size;
  }

  function renderStamp() {
    const d = state.data;
    if (!d) return;
    const g = new Date(d.generatedAt);
    const t = g.toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const fd = d.flowDate ? d.flowDate.slice(4, 6) + "/" + d.flowDate.slice(6, 8) : "–";
    const st = (d.indices && d.indices.KOSPI && d.indices.KOSPI.status) === "OPEN" ? "장중" : "장마감";
    // NXT 프리/애프터 시세가 반영된 종목이 있으면 그 세션명을 보여준다.
    const nx = (d.stocks || []).reduce((a, s) => (s.nxt === "프리" ? a[0]++ : s.nxt ? a[1]++ : 0, a), [0, 0]);
    const ses = (nx[0] || nx[1]) ? (nx[0] > nx[1] ? "프리장" : "애프터장") : st;
    $("#stamp").textContent = `갱신 ${t} · ${ses} · 외인수급 ${fd} 기준 · ${nf.format(d.counts.total)}종목`;
  }

  /* ─────────────────────────── 상단 시장 요약 ─────────────────────────── */
  function renderStrip() {
    const d = state.data, ix = d.indices || {}, out = [];
    const icard = (key, label) => {
      const i = ix[key] || {};
      const c = cls(i.chgPct);
      const flows = (i.personal !== undefined && i.personal !== null) ? `
        <div class="flows">
          <span>개인 <b class="${cls(i.personal)}">${won(i.personal * 1e8)}</b></span>
          <span>외인 <b class="${cls(i.foreign)}">${won(i.foreign * 1e8)}</b></span>
          <span>기관 <b class="${cls(i.institution)}">${won(i.institution * 1e8)}</b></span>
        </div>` : "";
      return `<div class="mcard big">
        <div class="lab">${label}</div>
        <div class="val ${c}">${i.price != null ? nf.format(i.price.toFixed(2)) : "–"}</div>
        <div class="sub ${c}">${signedTxt(i.change, 2, "")} · ${signedTxt(i.chgPct, 2)}</div>
        ${flows}
      </div>`;
    };
    out.push(icard("KOSPI", "코스피"));
    out.push(icard("KOSDAQ", "코스닥"));

    const fmtMacro = (m) => {
      if (!m) return "";
      const c = cls(m.chgPct);
      let val;
      if (m.key === "USDKRW") val = m.price != null ? nf.format(Math.round(m.price)) + "원" : "–";
      else if (m.key === "NQ") val = m.price != null ? nf.format(Math.round(m.price)) : "–";
      else if (m.key === "SOX") val = m.price != null ? nf.format(Math.round(m.price)) : "–";
      else val = m.price != null ? "$" + Number(m.price).toFixed(2) : "–";
      return `<div class="mcard" title="${m.label} (${m.symbol})">
        <div class="lab">${m.label}</div>
        <div class="val ${c}">${val}</div>
        <div class="sub ${c}">${signedTxt(m.chgPct, 2)}${m.stale ? " · 지연" : ""}</div>
      </div>`;
    };
    (d.macro || []).forEach(m => out.push(fmtMacro(m)));

    const up = d.counts.up, dn = d.counts.down;
    out.push(`<div class="mcard">
      <div class="lab">상승 / 하락</div>
      <div class="val"><span class="up">${up}</span> <span style="color:#33404f">/</span> <span class="down">${dn}</span></div>
      <div class="sub">보합 ${d.counts.flat}</div>
    </div>`);
    $("#strip").innerHTML = out.join("");
  }

  /* ─────────────────────────── 목록 ─────────────────────────── */
  /* 추세·저PER 조건: PER 상한(적자 제외) + 추세전환(60/120일선 돌파·최근 5거래일 또는 60·120 위) */
  const BRK_WINDOW = 4;   // 돌파 후 4거래일 전까지(=최근 5거래일) 인정
  function trendOk(s, mode) {
    const x60 = (s.x60 != null && s.x60 <= BRK_WINDOW) || s.b60 === 1;
    const x120 = (s.x120 != null && s.x120 <= BRK_WINDOW) || s.b120 === 1;
    if (mode === "b60") return x60;
    if (mode === "b120") return x120;
    if (mode === "above") return s.a60 === 1 && s.a120 === 1;
    return x60 || x120;
  }
  function hasLowPer(s, mode, max) {
    return s.per != null && s.per > 0 && s.per <= max && trendOk(s, mode);
  }

  function filtered() {
    const { data } = state;
    if (!data) return [];
    const q = state.q.trim().toLowerCase();
    let arr = data.stocks;
    if (state.market !== "ALL") arr = arr.filter(s => s.m === state.market);
    if (state.fMin) arr = arr.filter(s => s.fc >= state.fMin);
    if (state.oMin) arr = arr.filter(s => s.oc >= state.oMin);
    if (state.pMin) arr = arr.filter(s => s.pc >= state.pMin);
    if (state.both) arr = arr.filter(s => s.fq > 0 && s.oq > 0);
    if (state.chart && state.tab !== "lowper") {
      const k = state.chart;
      arr = arr.filter(s => s[k] === 1 || s[k] === true);
    }
    if (q) {
      arr = arr.filter(s => s.n.toLowerCase().includes(q) || s.c.includes(q));
    }
    if (state.tab === "foreign") {
      arr = arr.filter(s => (s.fq > 0 || s.fv > 0));
    }
    if (state.tab === "inst") {
      arr = arr.filter(s => (s.oq > 0 || s.oc > 0));
    }
    if (state.tab === "rose") {
      // 직전 거래일에 상승 마감한 종목만 (pchp: 전일 등락률)
      arr = arr.filter(s => s.pchp !== null && s.pchp !== undefined && s.pchp > 0);
      if (state.rMin) arr = arr.filter(s => s.pchp >= state.rMin);
    }
    if (state.tab === "mine") {
      arr = arr.filter(s => state.watch.has(s.c));
    }
    if (state.tab === "lowper") {
      // 추세전환(60·120일선 돌파) + PER 상한 이하(적자 제외)
      arr = arr.filter(s => hasLowPer(s, state.trend, state.perMax));
    }
    const k = state.sort.key, dir = state.sort.dir;
    arr = arr.slice().sort((a, b) => {
      const av = valOf(a, k), bv = valOf(b, k);
      const an = av === null || av === undefined ? -Infinity : av;
      const bn = bv === null || bv === undefined ? -Infinity : bv;
      if (typeof an === "string") return dir * an.localeCompare(bn);
      return dir * (an - bn);
    });
    return arr;
  }

  function valOf(s, k) {
    if (k === "pnl") {
      const h = state.holdings[s.c];
      return (h && h.q && h.a && s.p) ? (s.p / h.a - 1) * 100 : null;
    }
    return s[k];
  }

  /* 탭별 열 구성. h: 셀 렌더러, hideSm: 모바일 카드에서 숨김, sort:false → 정렬 불가 */
  const cell = {
    chp: s => `<span class="${cls(s.chp)}">${chAmt(s)} ${signedTxt(s.chp)}</span>`,
    pchp: s => `<span class="${cls(s.pchp)}">${signedTxt(s.pchp)}</span>`,
    c2d: s => `<span class="${cls(s.c2d)}">${signedTxt(s.c2d)}</span>`,
    fv: s => `<span class="${cls(s.fv)}">${won(s.fv)}</span>`,
    fq: s => `<span class="${cls(s.fq)}">${s.fq != null ? nf.format(s.fq) : "–"}</span>`,
    fvc: s => `<span class="${cls(s.fvc)}">${won(s.fvc)}</span>`,
    oq: s => `<span class="${cls(s.oq)}">${s.oq != null ? nf.format(s.oq) : "–"}</span>`,
    oqc: s => `<span class="${cls(s.oq)}">${s.oq != null ? nf.format(s.oq) + "주" : "–"}</span>`,
    va: s => won(s.va),
    r20: s => `<span class="${cls(s.r20)}">${signedTxt(s.r20, 1)}</span>`,
    ma: s => maBadges(s),
    per: s => {
      if (s.per == null) return '<span class="flat">–</span>';
      const k = s.per <= 5 ? "per-lo" : s.per <= 10 ? "per-mid" : "per-over";
      return `<span class="perv ${k}">${s.per.toFixed(1)}배</span>`;
    },
    pnl: s => {
      const h = state.holdings[s.c];
      if (!h || !h.q || !h.a) return '<span class="flat">–</span>';
      const pct = s.p ? (s.p / h.a - 1) * 100 : null;
      return `<span class="${cls(pct)}">${signedTxt(pct, 2)}</span> <small style="color:#63708a;font-weight:400">${nf.format(h.q)}주</small>`;
    }
  };

  const COLS = {
    all: [
      { k: "chp", l: "등락률" },
      { k: "fv", l: "외인 순매수", title: "가장 최근 발표된 외국인 순매수 금액(추정)" },
      { k: "fq", l: "순매수 주수", hideSm: 1 },
      { k: "va", l: "거래대금", hideSm: 1 },
      { k: "ma", l: "MA", hideSm: 1, sort: false },
      { k: "r20", l: "20일", hideSm: 1 }
    ],
    foreign: [
      { k: "chp", l: "등락률" },
      { k: "fv", l: "외인 순매수" },
      { k: "fq", l: "순매수 주수", hideSm: 1 },
      { k: "fvc", l: "누적 순매수", title: "연속 순매수 기간 누적 금액" },
      { k: "va", l: "거래대금", hideSm: 1 }
    ],
    inst: [
      { k: "chp", l: "등락률" },
      { k: "oq", l: "기관 순매수량", title: "최근 발표일 기관 순매수 주수" },
      { k: "fv", l: "외인 순매수", hideSm: 1 },
      { k: "va", l: "거래대금", hideSm: 1 }
    ],
    rose: [
      { k: "chp", l: "등락률" },
      { k: "pchp", l: "전일", title: "직전 거래일 등락률" },
      { k: "c2d", l: "2일 누적", title: "전일 + 오늘 2거래일 누적 등락률" },
      { k: "fv", l: "외인 순매수", hideSm: 1 },
      { k: "va", l: "거래대금", hideSm: 1 }
    ],
    mine: [
      { k: "chp", l: "등락률" },
      { k: "pnl", l: "평가손익", title: "저장한 보유 수량·평단 기준" },
      { k: "r20", l: "20일" },
      { k: "fv", l: "외인 순매수", hideSm: 1 },
      { k: "va", l: "거래대금", hideSm: 1 }
    ],
    lowper: [
      { k: "per", l: "PER", title: "주가수익비율(배) · 적자(0 이하) 제외 · 네이버 금융" },
      { k: "chp", l: "등락률" },
      { k: "ma", l: "MA", hideSm: 1, sort: false },
      { k: "fv", l: "외인 순매수", hideSm: 1 },
      { k: "r20", l: "20일" },
      { k: "va", l: "거래대금", hideSm: 1 }
    ]
  };

  const QUICK = {
    all: [["va", "거래대금"], ["chp", "등락률"], ["fv", "외인금액"], ["fc", "외인연속"], ["pc", "상승연속"]],
    foreign: [["fv", "외인금액"], ["fvc", "누적금액"], ["fq", "주수"], ["fc", "외인연속"], ["va", "거래대금"]],
    inst: [["oq", "기관주수"], ["oc", "기관연속"], ["fv", "외인금액"], ["va", "거래대금"]],
    rose: [["chp", "오늘"], ["pchp", "전일"], ["c2d", "2일누적"], ["fc", "외인연속"], ["pc", "상승연속"]],
    mine: [["chp", "등락률"], ["pnl", "평가손익"], ["r20", "20일"], ["fc", "외인연속"]],
    lowper: [["per", "PER 낮은순"], ["chp", "등락률"], ["r20", "20일"], ["fv", "외인금액"], ["va", "거래대금"]]
  };

  const CHART_LABEL = { b60: "60일선 돌파", b120: "120일선 돌파", a60: "60일선 위", a120: "120일선 위" };
  const TREND_LABEL = {
    both: "60/120일선 돌파(최근 5거래일)", b60: "60일선 돌파(최근 5거래일)",
    b120: "120일선 돌파(최근 5거래일)", above: "60·120일선 위"
  };

  function maBadges(s) {
    const b = (label, key) => {
      const v = s[key];
      if (v == null) return `<i class="n" title="${label}일선 데이터 없음">${label}</i>`;
      const ok = s.p >= v;
      return `<i class="${ok ? "y" : "x"}" title="${label}일선 ${fmt(v)} · ${ok ? "위" : "아래"}">${label}</i>`;
    };
    return `<div class="mas">${b("5", "ma5")}${b("20", "ma20")}${b("60", "ma60")}${b("120", "ma120")}${b("200", "ma200")}</div>`;
  }

  /* 종목명 아래 배지: 외인/기관 연속, 연속 상승, 이평선 돌파 */
  function badges(s) {
    const out = [];
    const fcAmt = (state.tab === "foreign" && s.fvc) ? ` · ${won(s.fvc)}` : "";
    if (s.fc) {
      const t = `외국인 ${Math.abs(s.fc)}일 연속 ${s.fc > 0 ? "순매수" : "순매도"}` + (s.fvc ? ` · 누적 ${won(s.fvc)}` : "");
      out.push(`<span class="pill ${s.fc > 0 ? "f" : "o"}" title="${t}">외인 ${Math.abs(s.fc)}일${s.fc > 0 ? "↑" : "↓"}${fcAmt}</span>`);
    }
    if (s.oc) {
      out.push(`<span class="pill ${s.oc > 0 ? "f" : "o"}" title="기관 ${Math.abs(s.oc)}일 연속 ${s.oc > 0 ? "순매수" : "순매도"}">기관 ${Math.abs(s.oc)}일${s.oc > 0 ? "↑" : "↓"}</span>`);
    }
    if (s.pc && Math.abs(s.pc) >= 2) {
      out.push(`<span class="pill s-strong" title="${Math.abs(s.pc)}일 연속 ${s.pc > 0 ? "상승" : "하락"}">${Math.abs(s.pc)}일 ${s.pc > 0 ? "상승" : "하락"}</span>`);
    }
    if (s.b60) out.push('<span class="mb brk" title="전일 60일선 아래 → 오늘 60일선 돌파">60일↑</span>');
    if (s.b120) out.push('<span class="mb brk" title="전일 120일선 아래 → 오늘 120일선 돌파">120일↑</span>');
    if (!s.b60 && s.a60) out.push('<span class="mb above" title="현재가 60일선 위">60일위</span>');
    if (!s.b120 && s.a120) out.push('<span class="mb above" title="현재가 120일선 위">120일위</span>');
    return out.length ? out.join("") : '<span class="pill n">–</span>';
  }

  /* ─────────────────── NXT 프리·애프터마켓 시세 표시 ─────────────────── */
  function nxtBadge(s) {
    if (!s.nxt) return "";
    const k = s.nxt === "프리" ? "pre" : "af";
    const when = s.nxt === "프리" ? "프리마켓 08:00~08:50" : "애프터마켓 15:40~20:00";
    return `<span class="nxt ${k}" title="NXT ${when} 체결가">${s.nxt}</span>`;
  }

  function rowHtml(s) {
    const cols = COLS[state.tab] || COLS.all;
    const star = state.watch.has(s.c) ? '<span style="color:#f5c451">★</span>' : "";
    const cells = cols.map(c => {
      const h = c.h || cell[c.k] || (x => "–");
      return `<td data-k="${c.k}" class="${c.hideSm ? "hide-sm " : ""}mono">${h(s)}</td>`;
    }).join("");
    return `<tr data-code="${s.c}">
      <td class="c-name">
        <div class="nm">${star}${s.n}<span class="code">${s.c}</span><span class="mkt ${s.m}">${s.m === "K" ? "코스피" : "코스닥"}</span></div>
        <div class="badges">${badges(s)}</div>
      </td>
      <td data-k="p" class="pcell ${cls(s.chp)}">${fmt(s.p)}${nxtBadge(s)}</td>
      ${cells}
    </tr>`;
  }

  function renderHead() {
    const cols = COLS[state.tab] || COLS.all;
    $("#thead").innerHTML = `<tr><th class="c-name">종목</th>
      <th class="c-num sortable" data-sort="p">현재가</th>` +
      cols.map(c => `<th class="c-num${c.sort === false ? "" : " sortable"}${c.hideSm ? " hide-sm" : ""}" data-sort="${c.k}"${c.title ? ` title="${c.title}"` : ""}>${c.l}</th>`).join("") +
      `</tr>`;
  }

  function renderTable() {
    const arr = filtered();
    const shown = arr.slice(0, state.limit);
    renderHead();
    $("#tbody").innerHTML = shown.map(rowHtml).join("");
    $("#empty").hidden = arr.length !== 0;
    $("#more").hidden = arr.length <= state.limit;
    if (arr.length > state.limit) $("#more").textContent = `더 보기 (${nf.format(arr.length - state.limit)}개 남음)`;

    const base = {
      all: "종합", foreign: "외국인 순매수 상위", inst: "기관 순매수 상위",
      rose: "전일 상승 → 오늘", lowper: "추세전환 · 저PER", mine: "내 종목"
    }[state.tab];
    const bits = [];
    if (state.market !== "ALL") bits.push(state.market === "K" ? "코스피" : "코스닥");
    if (state.rMin && state.tab === "rose") bits.push(`전일 +${state.rMin}%↑`);
    if (state.fMin) bits.push(`외인 ${state.fMin}일+`);
    if (state.oMin) bits.push(`기관 ${state.oMin}일+`);
    if (state.pMin) bits.push(`${state.pMin}일+ 상승`);
    if (state.both) bits.push("쌍끌이");
    if (state.chart) bits.push(CHART_LABEL[state.chart]);
    if (state.tab === "lowper") {
      bits.push(TREND_LABEL[state.trend] || TREND_LABEL.both);
      bits.push(`PER ≤ ${state.perMax}`);
    }
    if (state.q) bits.push(`"${state.q}"`);
    $("#tinfo").innerHTML = `<b>${nf.format(arr.length)}</b>종목 · ${base}${bits.length ? " · " + bits.join(" · ") : ""}` +
      (state.data && state.data.flowDate ? ` <span style="color:#63708a">(외인수급 ${state.data.flowDate.slice(4, 6)}/${state.data.flowDate.slice(6, 8)})</span>` : "");

    const cols = QUICK[state.tab] || QUICK.all;
    $("#tsort").innerHTML = cols.map(([k, l]) =>
      `<button data-quick="${k}" class="${state.sort.key === k ? "on" : ""}">${l}</button>`).join("");

    $$("#thead th").forEach(th => {
      th.classList.toggle("sorted", th.dataset.sort === state.sort.key);
      th.classList.toggle("asc", th.dataset.sort === state.sort.key && state.sort.dir === 1);
    });
    renderRoseSum();
    renderLowPerSum(arr);
  }

  /* ──────────────── 추세·저PER 한 줄 요약 ──────────────── */
  function renderLowPerSum(arr) {
    const el = $("#lpsum");
    if (!el) return;
    if (!state.data || state.tab !== "lowper") { el.hidden = true; return; }
    el.hidden = false;
    const k = arr.filter(s => s.m === "K").length;
    const pers = arr.map(s => s.per).filter(v => v != null).sort((a, b) => a - b);
    const med = pers.length ? pers[Math.floor((pers.length - 1) / 2)] : null;
    const cond = TREND_LABEL[state.trend] || TREND_LABEL.both;
    const pool = state.data.stocks.filter(s => s.per != null && s.per > 0 && s.per <= state.perMax).length;
    el.innerHTML = `
      <div class="rline">저PER 추세전환 <b>${nf.format(arr.length)}</b>종목 <span style="color:#63708a">(코스피 ${k} · 코스닥 ${arr.length - k})</span></div>
      <div class="rmeta">${cond} · PER ≤ ${state.perMax}배 (적자 제외) · PER 중앙값 <b>${med != null ? med.toFixed(1) : "–"}</b> · PER ≤ ${state.perMax} 전체 ${nf.format(pool)}종목 중 · PER은 최근 결산 EPS 대비 현재가(네이버 금융)</div>`;
  }

  /* ──────────────── 전일 상승 → 오늘 한 줄 요약 ──────────────── */
  function renderRoseSum() {
    const el = $("#rosesum");
    if (!el) return;
    const d = state.data;
    if (!d || state.tab !== "rose") { el.hidden = true; return; }
    el.hidden = false;
    const pool = d.stocks.filter(s => state.market === "ALL" || s.m === state.market);
    const rose = pool.filter(s => s.pchp !== null && s.pchp !== undefined && s.pchp > 0);
    const up = rose.filter(s => (s.chp || 0) > 0).length;
    const dn = rose.filter(s => (s.chp || 0) < 0).length;
    const fl = rose.length - up - dn;
    const rate = rose.length ? (up / rose.length) * 100 : 0;
    const mk = state.market === "ALL" ? "전체" : state.market === "K" ? "코스피" : "코스닥";
    const fd = d.flowDate ? `${d.flowDate.slice(4, 6)}/${d.flowDate.slice(6, 8)}` : "직전";
    el.innerHTML = `
      <div class="rline">${mk} · 전일(${fd}) 상승 <b>${nf.format(rose.length)}</b>종목 중 오늘 상승 <b class="up">${nf.format(up)}</b>종목 <span class="rrate ${cls(rate - 50)}">${rate.toFixed(1)}%</span></div>
      <div class="rbar"><i style="width:${Math.min(100, rate).toFixed(1)}%"></i></div>
      <div class="rmeta">오늘 하락 ${nf.format(dn)} · 보합 ${nf.format(fl)} · 전일 상승 종목 기준</div>`;
  }

  /* ─────────────────────────── 상세 ─────────────────────────── */
  async function openDetail(code) {
    const s = state.byCode.get(code);
    if (!s) return;
    state.openCode = code;
    $("#drawer").hidden = false;
    document.body.style.overflow = "hidden";
    $("#dName").textContent = s.n;
    $("#dCode").textContent = s.c;
    $("#dMkt").textContent = s.m === "K" ? "코스피" : "코스닥";
    paintHeader(s);
    $("#dBody").innerHTML = '<div class="hint">불러오는 중…</div>';

    let rows = state.hcache.get(code);
    if (!rows) {
      try {
        const key = code.slice(0, 2);
        let shard = state.hcache.get("__shard_" + key);
        if (!shard) {
          const r = await fetch(`data/h/${key}.json`, { cache: "no-store" });
          shard = r.ok ? await r.json() : {};
          state.hcache.set("__shard_" + key, shard);
        }
        rows = shard[code] || [];
        state.hcache.set(code, rows);
      } catch (e) { rows = []; }
    }
    if (state.openCode !== code) return;
    const chartRows = await loadChartRows(code, rows || []);
    if (state.openCode !== code) return;
    renderDetail(s, rows || [], chartRows);
  }

  /* 1년 차트용 일봉: data/y/{코드앞4자리}.json (완결된 봉) + 수급 shard의 당일 봉 */
  async function loadChartRows(code, hrows) {
    const key = code.slice(0, 4);
    let shard = state.hcache.get("__y_" + key);
    if (!shard) {
      try {
        const r = await fetch(`data/y/${key}.json`, { cache: "no-store" });
        shard = r.ok ? await r.json() : {};
      } catch (e) { shard = {}; }
      state.hcache.set("__y_" + key, shard);
    }
    const rows = (shard[code] || []).map(r => [Number(r[0]), r[1], r[2], r[3], r[4], r[5]]);
    // 오늘 봉(장중 체결 포함)은 수급 shard 값으로 이어 붙인다.
    (hrows || []).forEach(r => {
      const d = Number(String(r[0]).slice(2));
      if (!rows.length) { rows.push([d, r[1], r[2], r[3], r[4], r[5]]); return; }
      const last = rows[rows.length - 1];
      if (d > last[0]) rows.push([d, r[1], r[2], r[3], r[4], r[5]]);
      else if (d === last[0]) { last[1] = r[1]; last[2] = r[2]; last[3] = r[3]; last[4] = r[4]; last[5] = r[5]; }
    });
    rows.sort((a, b) => a[0] - b[0]);
    return rows.slice(-420);
  }

  function paintHeader(s) {
    const c = cls(s.chp);
    $("#dPrice").textContent = fmt(s.p);
    $("#dPrice").className = c;
    $("#dChg").className = c;
    $("#dChg").textContent = `${s.ch != null ? (s.ch > 0 ? "+" : "") + nf.format(s.ch) : "–"} (${signedTxt(s.chp)})`;
    const dn = $("#dNxt");
    if (dn) {
      dn.hidden = !s.nxt;
      dn.innerHTML = s.nxt ? nxtBadge(s) : "";
    }
  }

  function renderDetail(s, rows, chartRows) {
    const maLine = [["ma5", "5일"], ["ma20", "20일"], ["ma60", "60일"], ["ma120", "120일"], ["ma200", "200일"]]
      .map(([k, l]) => {
        const v = s[k];
        const st = v == null ? '<span class="flat">–</span>'
          : `<span class="${s.p >= v ? "up" : "down"}">${fmt(v)} ${s.p >= v ? "위" : "아래"}</span>`;
        return `<div><span>${l}선</span><b>${st}</b></div>`;
      }).join("");

    const hold = state.holdings[s.c];
    const pnl = hold && hold.q && hold.a
      ? { val: hold.q * s.p, cost: hold.q * hold.a, pct: ((s.p - hold.a) / hold.a) * 100 } : null;

    const kv = [
      ["시가총액", won(s.mc)],
      ["PER", s.per != null ? s.per.toFixed(1) + "배" : "–"],
      ["PBR", s.pbr != null ? s.pbr.toFixed(2) + "배" : "–"],
      ["거래량", s.v ? nf.format(s.v) : "–"],
      ["거래대금", won(s.va)],
      ["외국인 소진율", s.fr != null ? s.fr.toFixed(2) + "%" : "–"],
      ["외인 순매수", s.fq ? nf.format(s.fq) + "주" : "–"],
      ["외인 금액(추정)", won(s.fv)],
      ["기관 순매수", s.oq ? nf.format(s.oq) + "주" : "–"],
      ["개인 순매수", s.iq ? nf.format(s.iq) + "주" : "–"],
      ["52주 최고", fmt(s.hi52)],
      ["52주 최저", fmt(s.lo52)],
      ["5일 수익률", signedTxt(s.r5, 2)],
      ["20일 수익률", signedTxt(s.r20, 2)],
      ["전일 등락률", signedTxt(s.pchp, 2)],
      ["2일 누적", signedTxt(s.c2d, 2)]
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");

    const fd = s.fd ? `${s.fd.slice(4, 6)}/${s.fd.slice(6, 8)}` : "–";
    const consec = [];
    if (s.fc) consec.push(`<span class="pill ${s.fc > 0 ? "f" : "o"}">외국인 ${Math.abs(s.fc)}일 연속 ${s.fc > 0 ? "순매수" : "순매도"}</span>`);
    if (s.oc) consec.push(`<span class="pill ${s.oc > 0 ? "f" : "o"}">기관 ${Math.abs(s.oc)}일 연속 ${s.oc > 0 ? "순매수" : "순매도"}</span>`);
    if (s.pc) consec.push(`<span class="pill s-strong">${Math.abs(s.pc)}일 연속 ${s.pc > 0 ? "상승" : "하락"}</span>`);
    if (s.fqc) consec.push(`<span class="pill n">누적 ${nf.format(s.fqc)}주 ${s.fvc ? "· " + won(s.fvc) : ""}</span>`);
    if (s.b60) consec.push('<span class="mb brk">60일선 돌파</span>');
    if (s.b120) consec.push('<span class="mb brk">120일선 돌파</span>');
    if (!s.b60 && s.x60 != null && s.x60 <= 9) consec.push(`<span class="mb">60일선 돌파 ${s.x60}거래일 전</span>`);
    if (!s.b120 && s.x120 != null && s.x120 <= 9) consec.push(`<span class="mb">120일선 돌파 ${s.x120}거래일 전</span>`);

    const hist = rows.slice(-16).reverse();
    const hrows = hist.map(r => {
      const [d, o, h, l, c, v, fq, oq, iq] = r;
      const prev = rows[rows.indexOf(r) - 1];
      const chp = prev && prev[4] ? (c / prev[4] - 1) * 100 : null;
      return `<tr>
        <td>${d.slice(4, 6)}/${d.slice(6, 8)}</td>
        <td class="mono">${fmt(c)}</td>
        <td class="mono ${cls(chp)}">${chp == null ? "–" : signedTxt(chp, 2)}</td>
        <td class="mono ${cls(fq)}">${fq == null ? "–" : nf.format(fq)}</td>
        <td class="mono ${cls(oq)}">${oq == null ? "–" : nf.format(oq)}</td>
        <td class="mono ${cls(iq)}">${iq == null ? "–" : nf.format(iq)}</td>
      </tr>`;
    }).join("");

    const starred = state.watch.has(s.c);

    $("#dBody").innerHTML = `
      <div class="sect">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${consec.join("") || '<span class="pill n">연속 신호 없음</span>'}</div>
        <div class="kv">${maLine}</div>
      </div>

      <div class="sect">
        <h3>차트 <span class="chinfo" id="chInfo"></span></h3>
        <div class="chbar" id="chBar">
          <div class="chgrp" id="chRng">
            <button data-rng="60">3개월</button>
            <button data-rng="120">6개월</button>
            <button data-rng="250" class="on">1년</button>
          </div>
          <div class="chgrp">
            <button id="chZo" title="축소" aria-label="축소">−</button>
            <button id="chZi" title="확대" aria-label="확대">+</button>
            <button id="chRs" title="1년·최근으로">초기화</button>
          </div>
        </div>
        <div class="chwrap" id="chWrap">
          <canvas id="chart"></canvas>
          <div class="chtip" id="chTip" hidden></div>
        </div>
        <div class="chleg" id="chLeg">
          <button data-ch="ma5" class="on"><i style="background:${CHC.ma5}"></i>5일</button>
          <button data-ch="ma20" class="on"><i style="background:${CHC.ma20}"></i>20일</button>
          <button data-ch="ma60" class="on"><i style="background:${CHC.ma60}"></i>60일</button>
          <button data-ch="ma120" class="on"><i style="background:${CHC.ma120}"></i>120일</button>
          <button data-ch="ichi" class="on ichi"><i class="sw"></i>일목균형표</button>
        </div>
        <div class="hint">휠·두 손가락으로 확대/축소, 드래그·좌우 스와이프로 이동. 봉을 누르면 시·고·저·종가와 거래량이 나옵니다. 구름대는 빨강이 양운(상승), 파랑이 음운(하락)입니다.</div>
      </div>

      <div class="sect"><h3>종목 정보</h3><div class="kv">${kv}</div></div>

      <div class="sect">
        <h3>최근 일별 주가 · 수급 (기준일 ${fd})</h3>
        <table class="mini">
          <thead><tr><th>일자</th><th>종가</th><th>등락</th><th>외국인</th><th>기관</th><th>개인</th></tr></thead>
          <tbody>${hrows || '<tr><td colspan="6" style="text-align:center;color:#63708a">데이터 없음</td></tr>'}</tbody>
        </table>
        <div class="hint">외국인·기관·개인 수량 단위는 주. 당일 수급은 장 마감 후 확정치가 반영됩니다.</div>
      </div>

      <div class="sect">
        <h3>물타기 계산기</h3>
        <div class="calc" id="calc">
          <div class="btnrow" style="margin:0 0 9px">
            <button class="btn ${(calcState(s.c).mode || "add") === "add" ? "on" : ""}" data-mode="add">추가 매수</button>
            <button class="btn ${calcState(s.c).mode === "target" ? "on" : ""}" data-mode="target">목표 평단</button>
          </div>
          <div class="grid">
            <div><label>보유 수량(주)</label><input id="cQ" type="text" inputmode="numeric" value="${hold ? hold.q || "" : ""}" placeholder="0"></div>
            <div><label>평단가(원)</label><input id="cA" type="text" inputmode="numeric" value="${hold ? hold.a || "" : ""}" placeholder="0"></div>
            <div><label>현재가(원)</label><input id="cP" type="text" inputmode="numeric" value="${s.p}"></div>
            <div id="cAddWrap"><label>추가 매수 수량(주)</label><input id="cAdd" type="text" inputmode="numeric" placeholder="0"></div>
            <div id="cTgtWrap" hidden><label>목표 평단가(원)</label><input id="cTgt" type="text" inputmode="numeric" placeholder="0"></div>
          </div>
          <div class="out" id="cOut"></div>
          <div class="note" id="cNote"></div>
          <div class="btnrow">
            <button class="btn primary" id="cSave">보유 저장</button>
            <button class="btn" id="cClear">초기화</button>
          </div>
        </div>
      </div>

      <div class="sect">
        <h3>내 메모</h3>
        <textarea id="note" placeholder="이 종목에 대한 생각·계획을 적어두세요. 브라우저에만 저장됩니다.">${(state.notes[s.c] || "").replace(/</g, "&lt;")}</textarea>
        <div class="btnrow">
          <button class="btn ${starred ? "on" : ""}" id="watchBtn">${starred ? "★ 관심 종목 해제" : "☆ 관심 종목 추가"}</button>
          <a class="btn" style="text-decoration:none" href="https://m.stock.naver.com/domestic/stock/${s.c}" target="_blank" rel="noopener">네이버에서 보기 ↗</a>
          <span class="hint" id="noteSaved" style="margin:0;align-self:center"></span>
        </div>
      </div>
    `;

    chartOpen($("#chart"), chartRows && chartRows.length ? chartRows : rows.map(r => [Number(String(r[0]).slice(2)), r[1], r[2], r[3], r[4], r[5]]), s);
    bindChartUI();
    bindCalc(s, hold);
    $("#note").addEventListener("input", debounce(e => {
      const v = e.target.value.trim();
      if (v) state.notes[s.c] = v; else delete state.notes[s.c];
      LS.set("krt.note", state.notes);
      $("#noteSaved").textContent = "저장됨";
      setTimeout(() => { const el = $("#noteSaved"); if (el) el.textContent = ""; }, 1200);
    }, 400));
    $("#watchBtn").addEventListener("click", () => {
      if (state.watch.has(s.c)) state.watch.delete(s.c); else state.watch.add(s.c);
      LS.set("krt.watch", [...state.watch]);
      updateCounts();
      openDetail(s.c);
    });
  }

  function calcState(code) {
    const all = LS.get("krt.calc", {});
    return all[code] || {};
  }
  function saveCalc(code, obj) {
    const all = LS.get("krt.calc", {});
    all[code] = obj;
    LS.set("krt.calc", all);
  }

  function bindCalc(s, hold) {
    const pnlRow = () => {
      if (!hold || !hold.q || !hold.a) return "";
      const q = Number(hold.q), a = Number(hold.a), p = s.p;
      const pct = (p / a - 1) * 100, pl = q * (p - a);
      return `<div><span>보유 평가손익</span><b class="${cls(pct)}">${signedTxt(pct, 2)}</b></div>
              <div><span>평가금액 / 손익</span><b class="${cls(pl)}">${won(q * p)} <small style="color:#63708a;font-weight:400">${won(pl)}</small></b></div>`;
    };
    const saved = calcState(s.c);
    let mode = saved.mode || "add";
    const applyMode = () => {
      $("#cAddWrap").hidden = mode !== "add";
      $("#cTgtWrap").hidden = mode !== "target";
      $$("#calc [data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
    };
    applyMode();
    if (saved.add) $("#cAdd").value = saved.add;
    if (saved.tgt) $("#cTgt").value = saved.tgt;
    $$("#calc [data-mode]").forEach(b => b.addEventListener("click", () => {
      mode = b.dataset.mode; applyMode(); compute();
    }));

    const val = id => { const el = $(id); return el ? Number(String(el.value).replace(/[^\d.-]/g, "")) || 0 : 0; };
    const curPrice = () => val("#cP") || s.p;

    function compute() {
      const q = val("#cQ"), a = val("#cA"), p = curPrice();
      const out = $("#cOut"), note = $("#cNote");
      if (!q || !a || !p) {
        out.innerHTML = pnlRow() + '<div><span>새 평단가</span><b class="flat">–</b></div><div><span>필요 금액</span><b class="flat">–</b></div>';
        note.textContent = "보유 수량·평단가·현재가를 입력하면 계산됩니다.";
        return;
      }
      if (mode === "add") {
        const addQ = val("#cAdd");
        const newQ = q + addQ;
        const cost = q * a + addQ * p;
        const na = newQ ? cost / newQ : a;
        out.innerHTML = pnlRow() + `
          <div><span>새 평단가</span><b class="${na < a ? "down" : "flat"}">${fmt(na)}원</b></div>
          <div><span>평단 변화</span><b class="${cls(a - na)}">${signedTxt((na / a - 1) * 100, 2)}</b></div>
          <div><span>추가 투입</span><b>${addQ ? won(addQ * p) : "–"}</b></div>
          <div><span>총 보유</span><b>${nf.format(newQ)}주</b></div>`;
        note.textContent = addQ
          ? `현재가 ${fmt(p)}원으로 ${nf.format(addQ)}주 더 사면 평단 ${fmt(a)} → ${fmt(na)}원, 손익분기 ${fmt(na)}원입니다.`
          : "추가 매수 수량을 입력하세요.";
      } else {
        const t = val("#cTgt");
        if (!t) { out.innerHTML = ""; note.textContent = "목표 평단가를 입력하세요."; return; }
        if (p >= t) { out.innerHTML = ""; note.textContent = "현재가가 목표 평단가 이상이라 물타기로 도달할 수 없습니다."; return; }
        if (t >= a) { out.innerHTML = ""; note.textContent = "목표 평단가는 현재 평단보다 낮아야 합니다."; return; }
        const needQ = (q * (a - t)) / (t - p);
        out.innerHTML = pnlRow() + `
          <div><span>필요 매수 수량</span><b>${nf.format(Math.ceil(needQ))}주</b></div>
          <div><span>필요 금액</span><b>${won(Math.ceil(needQ) * p)}</b></div>
          <div><span>새 총 보유</span><b>${nf.format(Math.ceil(q + needQ))}주</b></div>
          <div><span>목표 평단</span><b>${fmt(t)}원</b></div>`;
        note.textContent = `평단 ${fmt(a)} → ${fmt(t)}원으로 낮추려면 ${fmt(p)}원에 ${nf.format(Math.ceil(needQ))}주를 더 사야 합니다.`;
      }
      saveCalc(s.c, { mode, add: $("#cAdd") ? $("#cAdd").value : "", tgt: $("#cTgt") ? $("#cTgt").value : "" });
    }
    ["#cQ", "#cA", "#cP", "#cAdd", "#cTgt"].forEach(id => { const el = $(id); if (el) el.addEventListener("input", compute); });

    $("#cSave").addEventListener("click", () => {
      const q = val("#cQ"), a = val("#cA");
      if (!q || !a) return;
      state.holdings[s.c] = { q, a };
      LS.set("krt.hold", state.holdings);
      state.watch.add(s.c);
      LS.set("krt.watch", [...state.watch]);
      updateCounts();
      $("#cSave").textContent = "저장됨";
      setTimeout(() => { const b = $("#cSave"); if (b) b.textContent = "보유 저장"; }, 1400);
    });
    $("#cClear").addEventListener("click", () => {
      delete state.holdings[s.c];
      LS.set("krt.hold", state.holdings);
      saveCalc(s.c, { mode });
      ["#cQ", "#cA", "#cAdd", "#cTgt"].forEach(id => { const el = $(id); if (el) el.value = ""; });
      compute();
    });
    compute();
  }

  /* ─────── 종목 상세 차트: 일봉·거래량 + 이동평균(5/20/60/120) + 일목균형표 ─────── */
  const CHC = {
    up: "#f6465d", down: "#3b82f6",
    ma5: "#22d3ee", ma20: "#ff8ad4", ma60: "#ffb347", ma120: "#c2a578",
    tenkan: "#4ade80", kijun: "#ffd166", chikou: "#1f8a5f",
    spanA: "#f87171", spanB: "#60a5fa",
    grid: "#1a2431", axis: "#63708a"
  };
  const CH_MA = [["ma5", 5, CHC.ma5], ["ma20", 20, CHC.ma20], ["ma60", 60, CHC.ma60], ["ma120", 120, CHC.ma120]];
  const CH_RANGE = { 60: "3개월", 120: "6개월", 250: "1년" };

  function chOpts() {
    const o = { ma5: 1, ma20: 1, ma60: 1, ma120: 1, ichi: 1 };
    const s = LS.get("krt.chart", null);
    if (s && typeof s === "object") Object.keys(o).forEach(k => { if (s[k] !== undefined) o[k] = s[k] ? 1 : 0; });
    return o;
  }

  const CH = {
    cv: null, g: null, wrap: null, tip: null,
    rows: [], ind: null, code: null,
    cssW: 0, cssH: 0, volH: 46,
    padL: 6, padR: 62, padT: 12, padB: 16, gapV: 12,
    view: { n: 250, end: 0 },
    opts: chOpts(),
    hover: null, ptrs: new Map(), drag: null, pinch: null, tap: null, lastTap: 0
  };

  function chartDate(v) {
    const s = String(v).padStart(6, "0");
    const yy = 2000 + Number(s.slice(0, 2)), mm = Number(s.slice(2, 4)), dd = Number(s.slice(4, 6));
    const wd = "일월화수목금토"[new Date(yy, mm - 1, dd).getDay()];
    return { full: `${yy}.${s.slice(2, 4)}.${s.slice(4, 6)}`, short: `${s.slice(2, 4)}/${s.slice(4, 6)}`, ymd: `${s.slice(0, 2)}/${s.slice(2, 4)}/${s.slice(4, 6)}`, wd };
  }

  function chartIndicators(rows) {
    const N = rows.length;
    const C = new Array(N), Hh = new Array(N), Ll = new Array(N);
    for (let i = 0; i < N; i++) { C[i] = rows[i][4]; Hh[i] = rows[i][2]; Ll[i] = rows[i][3]; }
    const ma = step => {
      const out = new Array(N).fill(null);
      let sum = 0;
      for (let i = 0; i < N; i++) {
        sum += C[i];
        if (i >= step) sum -= C[i - step];
        if (i >= step - 1) out[i] = sum / step;
      }
      return out;
    };
    const mid = (a, b) => {
      let mx = -Infinity, mn = Infinity;
      for (let i = a; i <= b; i++) { if (Hh[i] > mx) mx = Hh[i]; if (Ll[i] < mn) mn = Ll[i]; }
      return (mx + mn) / 2;
    };
    const tenkan = new Array(N).fill(null), kijun = new Array(N).fill(null);
    for (let i = 8; i < N; i++) tenkan[i] = mid(i - 8, i);
    for (let i = 25; i < N; i++) kijun[i] = mid(i - 25, i);
    // 선행스팬 26봉 우측 이동 → 배열을 N+26까지 잡아 미래 영역(구름대)을 그린다
    const spanA = new Array(N + 26).fill(null), spanB = new Array(N + 26).fill(null);
    for (let i = 0; i < N; i++) {
      if (tenkan[i] != null && kijun[i] != null) spanA[i + 26] = (tenkan[i] + kijun[i]) / 2;
      if (i >= 51) spanB[i + 26] = mid(i - 51, i);
    }
    // 후행스팬: 종가를 26봉 왼쪽으로 이동
    const chikou = new Array(N).fill(null);
    for (let i = 0; i + 26 < N; i++) chikou[i] = C[i + 26];
    return {
      C, H: Hh, L: Ll,
      ma5: ma(5), ma20: ma(20), ma60: ma(60), ma120: ma(120),
      tenkan, kijun, spanA, spanB, chikou
    };
  }

  function chartGeom() {
    const N = CH.rows.length || 1;
    const padL = CH.padL, padR = CH.padR, padT = CH.padT, padB = CH.padB;
    const plotW = Math.max(40, CH.cssW - padL - padR);
    const volH = CH.volH, gapV = CH.gapV;
    const priceH = Math.max(60, CH.cssH - padT - padB - volH - gapV);
    const FUT = CH.opts.ichi ? 26 : 0;
    const n = Math.max(Math.min(20, N), Math.min(CH.view.n, N));
    const end = Math.max(n, Math.min(CH.view.end || N, N));
    const start = Math.max(0, end - n);
    const cnt = end - start;
    const sw = plotW / Math.max(1, cnt + FUT);
    return { padL, padR, padT, padB, plotW, priceH, volH, gapV, n, end, start, cnt, sw, FUT, N };
  }

  function chartResize() {
    const cv = CH.cv;
    if (!cv) return;
    const px = (cv.parentElement && cv.parentElement.clientWidth) || cv.clientWidth || 480;
    CH.cssW = Math.max(220, Math.round(px));
    CH.cssH = CH.cssW < 460 ? 300 : 360;
    CH.volH = Math.round(CH.cssH * 0.18);
    CH.padR = CH.cssW < 460 ? 54 : 62;
  }

  function chartOpen(cv, rows, s) {
    CH.cv = cv || null;
    CH.g = cv ? cv.getContext("2d") : null;
    CH.wrap = cv ? cv.parentElement : null;
    CH.tip = $("#chTip");
    CH.rows = (rows || []).slice();
    CH.ind = CH.rows.length ? chartIndicators(CH.rows) : null;
    CH.code = s ? s.c : null;
    CH.opts = chOpts();
    CH.hover = null;
    const N = CH.rows.length;
    CH.view = { n: Math.min(250, Math.max(20, N)), end: N };
    chartResize();
    chartBind();
    syncChBtns();
    chartDraw();
  }

  function chartDraw() {
    const cv = CH.cv, g = CH.g, rows = CH.rows, ind = CH.ind;
    if (!cv || !g || !rows.length || !ind) return;
    const dpr = window.devicePixelRatio || 1;
    const W = CH.cssW, H = CH.cssH;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    cv.style.height = H + "px";
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#0d131b";
    g.fillRect(0, 0, W, H);

    const o = CH.opts, N = rows.length;
    const G = chartGeom();
    const { padL, padR, padT, padB, plotW, priceH, volH, gapV, start, end, cnt, sw, FUT } = G;
    const X = i => padL + (i - start + 0.5) * sw;
    const yTop = padT, yBot = padT + priceH;
    const vTop = yBot + gapV;

    /* ── 세로(가격) 범위: 봉 + 보조지표 + 미래 구름대 */
    let lo = Infinity, hi = -Infinity;
    const add = v => { if (v == null || !isFinite(v)) return; if (v < lo) lo = v; if (v > hi) hi = v; };
    for (let i = start; i < end; i++) { add(rows[i][3]); add(rows[i][2]); }
    if (o.ichi) for (let i = start; i < end + FUT; i++) { add(ind.spanA[i]); add(ind.spanB[i]); }
    CH_MA.forEach(([k]) => { if (!o[k]) return; for (let i = start; i < end; i++) add(ind[k][i]); });
    if (o.ichi) for (let i = start; i < end; i++) { add(ind.tenkan[i]); add(ind.kijun[i]); add(ind.chikou[i]); }
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi <= lo) hi = lo + 1;
    const padV = (hi - lo) * 0.06;
    lo -= padV; hi += padV;
    const Y = v => yBot - ((v - lo) / (hi - lo)) * priceH;

    /* ── 그리드 + 오른쪽 가격 눈금 */
    g.font = "10px -apple-system,BlinkMacSystemFont,system-ui,sans-serif";
    g.textBaseline = "middle";
    g.strokeStyle = CHC.grid;
    g.lineWidth = 1;
    for (let t = 0; t <= 4; t++) {
      const y = Math.round(yTop + (priceH / 4) * t) + 0.5;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
      const v = hi - ((hi - lo) / 4) * t;
      g.fillStyle = CHC.axis;
      g.textAlign = "left";
      g.fillText(nf.format(Math.round(v)), padL + plotW + 6, y);
    }

    /* ── 일목균형표 구름대 (캔들 아래에 깔린다) */
    if (o.ichi) {
      const iMax = Math.min(end + FUT, N + 26);
      for (let i = Math.max(start + 1, 1); i < iMax; i++) {
        const a0 = ind.spanA[i - 1], b0 = ind.spanB[i - 1], a1 = ind.spanA[i], b1 = ind.spanB[i];
        if (a0 == null || b0 == null || a1 == null || b1 == null) continue;
        const up = (a0 + a1) >= (b0 + b1);
        const x0 = X(i - 1), x1 = X(i);
        g.fillStyle = up ? "rgba(246,70,93,.16)" : "rgba(59,130,246,.16)";
        g.beginPath();
        g.moveTo(x0, Y(a0)); g.lineTo(x1, Y(a1)); g.lineTo(x1, Y(b1)); g.lineTo(x0, Y(b0));
        g.closePath(); g.fill();
      }
    }

    /* ── 캔들 */
    const bw = Math.max(1, Math.min(11, Math.round(sw * 0.72)));
    for (let i = start; i < end; i++) {
      const r = rows[i], up = r[4] >= r[1];
      const xc = Math.round(X(i));
      const x = xc + 0.5;
      g.strokeStyle = g.fillStyle = up ? CHC.up : CHC.down;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, Y(r[2])); g.lineTo(x, Y(r[3])); g.stroke();
      const y1 = Math.round(Y(Math.max(r[1], r[4]))), y2 = Math.round(Y(Math.min(r[1], r[4])));
      g.fillRect(xc - Math.floor(bw / 2), y1, bw, Math.max(1, y2 - y1));
    }

    /* ── 선 그리기 헬퍼 */
    const line = (arr, color, width, from, to, dash) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      if (dash) g.setLineDash(dash);
      g.beginPath();
      let on = false;
      for (let i = from; i < to; i++) {
        const v = arr[i];
        if (v == null) { on = false; continue; }
        const x = X(i), y = Y(v);
        if (!on) { g.moveTo(x, y); on = true; } else g.lineTo(x, y);
      }
      g.stroke();
      if (dash) g.setLineDash([]);
    };

    /* ── 이동평균선 5·20·60·120 */
    CH_MA.forEach(([k, , c]) => { if (o[k]) line(ind[k], c, 1.3, start, end); });

    /* ── 일목균형표 선 */
    if (o.ichi) {
      line(ind.spanA, CHC.spanA, 1, start, end + FUT);
      line(ind.spanB, CHC.spanB, 1, start, end + FUT);
      line(ind.tenkan, CHC.tenkan, 1.1, start, end);
      line(ind.kijun, CHC.kijun, 1.1, start, end);
      line(ind.chikou, CHC.chikou, 1.1, start, end);
    }

    /* ── 거래량 */
    let vmax = 0;
    for (let i = start; i < end; i++) if (rows[i][5] > vmax) vmax = rows[i][5];
    vmax = vmax || 1;
    const vh = volH - 8;
    for (let i = start; i < end; i++) {
      const r = rows[i];
      // 거래량 색은 전일 종가 대비(상승 빨강 / 하락 파랑)
      const up = i > 0 ? r[4] >= rows[i - 1][4] : r[4] >= r[1];
      const h2 = (r[5] / vmax) * vh;
      g.fillStyle = up ? "rgba(246,70,93,.62)" : "rgba(59,130,246,.62)";
      g.fillRect(Math.round(X(i)) - Math.floor(bw / 2), Math.round(vTop + vh - h2), bw, Math.max(1, Math.round(h2)));
    }
    g.strokeStyle = CHC.grid;
    g.beginPath(); g.moveTo(padL, Math.round(vTop + vh) + 0.5); g.lineTo(padL + plotW, Math.round(vTop + vh) + 0.5); g.stroke();
    g.fillStyle = CHC.axis; g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText(won(vmax), padL + plotW + 6, vTop + 14);

    /* ── 날짜 눈금 */
    const tickN = plotW < 380 ? 3 : 5;
    const stepT = Math.max(1, Math.round(cnt / tickN));
    g.textAlign = "center"; g.textBaseline = "top";
    for (let i = start; i < end; i += stepT) {
      const x = Math.round(X(i)) + 0.5;
      g.strokeStyle = "rgba(33,43,56,.75)";
      g.beginPath(); g.moveTo(x, yTop); g.lineTo(x, yBot); g.stroke();
      g.fillStyle = CHC.axis;
      const lbl = chartDate(rows[i][0]).short;
      const tw = g.measureText(lbl).width / 2;
      g.fillText(lbl, Math.max(padL + tw, Math.min(x, padL + plotW - tw)), H - padB + 4);
    }

    /* ── 표시 구간 최고·최저 라벨 */
    let hiI = start, loI = start;
    for (let i = start; i < end; i++) {
      if (rows[i][2] > rows[hiI][2]) hiI = i;
      if (rows[i][3] < rows[loI][3]) loI = i;
    }
    const bubble = (v, i, isHigh) => {
      const txt = (isHigh ? "▲ " : "▼ ") + fmt(v);
      g.font = "600 9.5px -apple-system,system-ui,sans-serif";
      const w = g.measureText(txt).width + 9;
      const x = X(i);
      let cx = Math.min(Math.max(padL + w / 2, x), padL + plotW - w / 2);
      const y = Y(v);
      const cy = isHigh ? Math.max(yTop + 9, y - 10) : Math.min(yBot - 9, y + 10);
      g.fillStyle = isHigh ? "rgba(246,70,93,.95)" : "rgba(59,130,246,.95)";
      if (g.roundRect) { g.beginPath(); g.roundRect(cx - w / 2, cy - 8, w, 16, 4); g.fill(); }
      else g.fillRect(cx - w / 2, cy - 8, w, 16);
      g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(txt, cx, cy + 0.5);
    };
    bubble(rows[hiI][2], hiI, true);
    bubble(rows[loI][3], loI, false);

    /* ── 마지막 종가 태그 */
    const lastI = end - 1, lastC = rows[lastI][4];
    const prevC = lastI > 0 ? rows[lastI - 1][4] : lastC;
    const upLast = lastC >= prevC;
    const ly = Math.max(yTop + 8, Math.min(yBot - 8, Y(lastC)));
    g.fillStyle = upLast ? CHC.up : CHC.down;
    g.fillRect(padL + plotW + 1, ly - 8, padR - 3, 16);
    g.fillStyle = "#04121f"; g.font = "700 9.5px -apple-system,system-ui,sans-serif";
    g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText(fmt(lastC), padL + plotW + 4, ly + 0.5);

    /* ── 크로스헤어 */
    if (CH.hover && CH.hover.i >= start && CH.hover.i < end) {
      const i = CH.hover.i, x = Math.round(X(i)) + 0.5;
      g.save();
      g.strokeStyle = "rgba(150,175,205,.55)";
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, yTop); g.lineTo(x, vTop + vh + 4); g.stroke();
      const hy = Math.max(yTop, Math.min(yBot, CH.hover.y));
      g.beginPath(); g.moveTo(padL, Math.round(hy) + 0.5); g.lineTo(padL + plotW, Math.round(hy) + 0.5); g.stroke();
      g.restore();
      // 커서 높이의 가격
      const hv = lo + ((yBot - hy) / priceH) * (hi - lo);
      g.fillStyle = "#243447";
      if (g.roundRect) { g.beginPath(); g.roundRect(padL + plotW + 1, hy - 8, padR - 3, 16, 3); g.fill(); }
      else g.fillRect(padL + plotW + 1, hy - 8, padR - 3, 16);
      g.fillStyle = "#cfe0f5"; g.font = "600 9.5px -apple-system,system-ui,sans-serif";
      g.textAlign = "left"; g.textBaseline = "middle";
      g.fillText(nf.format(Math.round(hv)), padL + plotW + 4, hy + 0.5);
    }

    /* ── 요약 문구 */
    const info = $("#chInfo");
    if (info) {
      info.textContent = `${CH_RANGE[cnt] || cnt + "봉"} · 최고 ${fmt(rows[hiI][2])} (${chartDate(rows[hiI][0]).ymd}) · 최저 ${fmt(rows[loI][3])} (${chartDate(rows[loI][0]).ymd})`;
    }
    syncChBtns();
  }

  function syncChBtns() {
    const n = CH.view.n;
    $$("#chRng button").forEach(b => b.classList.toggle("on", Number(b.dataset.rng) === n));
    $$("#chLeg button").forEach(b => b.classList.toggle("on", !!CH.opts[b.dataset.ch]));
  }

  function chartZoom(f, xPx) {
    const N = CH.rows.length;
    if (!N) return;
    const G = chartGeom();
    const barW = G.plotW * (G.cnt / (G.cnt + G.FUT));
    const frac = Math.max(0, Math.min(1, (xPx - G.padL) / Math.max(1, barW)));
    const anchor = G.start + frac * G.cnt;
    const n1 = Math.max(Math.min(20, N), Math.min(N, Math.round(G.n * f)));
    let end1 = Math.round(anchor + (1 - frac) * n1);
    end1 = Math.max(n1, Math.min(N, end1));
    CH.view.n = n1; CH.view.end = end1;
    CH.hover = null; hideTip();
    chartDraw();
  }

  function chartReset() {
    const N = CH.rows.length;
    CH.view = { n: Math.min(250, Math.max(20, N)), end: N };
    CH.hover = null; hideTip();
    chartDraw();
  }

  function chartIndexAt(x) {
    const G = chartGeom();
    return Math.round((x - G.padL) / G.sw - 0.5) + G.start;
  }

  function showTip(i, x, y) {
    const tip = CH.tip, r = CH.rows[i];
    if (!tip || !r) return;
    const prev = i > 0 ? CH.rows[i - 1][4] : null;
    const chp = prev ? (r[4] / prev - 1) * 100 : null;
    const dt = chartDate(r[0]);
    tip.innerHTML = `<div class="td">${dt.full} <i>${dt.wd}</i></div>
      <div class="tg">
        <span>시가</span><b>${fmt(r[1])}</b>
        <span>고가</span><b>${fmt(r[2])}</b>
        <span>저가</span><b>${fmt(r[3])}</b>
        <span>종가</span><b class="${cls(chp)}">${fmt(r[4])}</b>
        <span>등락</span><b class="${cls(chp)}">${signedTxt(chp)}</b>
        <span>거래량</span><b>${won(r[5])}</b>
      </div>`;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const maxX = (CH.wrap ? CH.wrap.clientWidth : CH.cssW) - tw - 6;
    let left = Math.max(6, Math.min(maxX, x - tw / 2));
    let top = y - th - 14;
    if (top < 4) top = Math.min(CH.cssH - th - 6, y + 16);
    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
  }

  function hideTip() { if (CH.tip) CH.tip.hidden = true; }

  function chartBind() {
    const cv = CH.cv;
    if (!cv || cv.dataset.bound) return;
    cv.dataset.bound = "1";
    cv.style.touchAction = "none";
    if (!cv.hasAttribute("tabindex")) cv.setAttribute("tabindex", "0");
    const relX = e => e.clientX - cv.getBoundingClientRect().left;
    const relY = e => e.clientY - cv.getBoundingClientRect().top;

    // 키보드: ←→ 이동, +/- 확대축소, Home 1년 보기
    cv.addEventListener("keydown", e => {
      const N = CH.rows.length;
      if (!N) return;
      const G = chartGeom();
      const step = Math.max(1, Math.round(G.cnt * (e.shiftKey ? 0.5 : 0.1)));
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        CH.view.end = Math.max(G.n, Math.min(N, CH.view.end + (e.key === "ArrowRight" ? step : -step)));
        CH.hover = null; hideTip(); chartDraw();
      } else if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") {
        e.preventDefault();
        chartZoom((e.key === "+" || e.key === "=") ? 0.8 : 1.25, G.padL + G.plotW / 2);
      } else if (e.key === "Home") {
        e.preventDefault(); chartReset();
      }
    });

    cv.addEventListener("wheel", e => {
      e.preventDefault();
      chartZoom(e.deltaY < 0 ? 0.86 : 1.16, relX(e));
    }, { passive: false });

    cv.addEventListener("pointerdown", e => {
      try { cv.setPointerCapture(e.pointerId); } catch (err) {}
      CH.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (CH.ptrs.size === 1) {
        CH.drag = { x: e.clientX, end0: CH.view.end, moved: 0 };
        CH.tap = { t: Date.now(), x: e.clientX, y: e.clientY };
      } else if (CH.ptrs.size === 2) {
        CH.drag = null;
        const pts = [...CH.ptrs.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const G = chartGeom();
        const barW = G.plotW * (G.cnt / (G.cnt + G.FUT));
        const mid = (pts[0].x + pts[1].x) / 2 - cv.getBoundingClientRect().left;
        CH.pinch = {
          d, n0: G.n, end0: G.end,
          frac: Math.max(0, Math.min(1, (mid - G.padL) / Math.max(1, barW)))
        };
      }
    });

    cv.addEventListener("pointermove", e => {
      const p = CH.ptrs.get(e.pointerId);
      if (!p) {
        // 마우스 호버
        const G = chartGeom();
        const x = relX(e), y = relY(e);
        if (x < G.padL || x > G.padL + G.plotW || y < 0 || y > CH.cssH) { CH.hover = null; hideTip(); chartDraw(); return; }
        const i = chartIndexAt(x);
        if (i < G.start || i >= G.end) { CH.hover = null; hideTip(); chartDraw(); return; }
        CH.hover = { i, y };
        showTip(i, x, y);
        chartDraw();
        return;
      }
      p.x = e.clientX; p.y = e.clientY;

      if (CH.ptrs.size >= 2 && CH.pinch) {
        const pts = [...CH.ptrs.values()].slice(0, 2);
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const P = CH.pinch, N = CH.rows.length;
        const anchor = (P.end0 - P.n0) + P.frac * P.n0;
        let n1 = Math.round(P.n0 * P.d / d);
        n1 = Math.max(Math.min(20, N), Math.min(N, n1));
        let end1 = Math.round(anchor + (1 - P.frac) * n1);
        end1 = Math.max(n1, Math.min(N, end1));
        if (n1 !== CH.view.n || end1 !== CH.view.end) {
          CH.view.n = n1; CH.view.end = end1;
          CH.hover = null; hideTip(); chartDraw();
        }
        return;
      }

      if (CH.drag) {
        const dx = e.clientX - CH.drag.x;
        if (Math.abs(dx) > CH.drag.moved) CH.drag.moved = Math.abs(dx);
        if (Math.abs(dx) > 3) {
          const G = chartGeom();
          const end = Math.max(G.n, Math.min(G.N, Math.round(CH.drag.end0 - dx / G.sw)));
          if (end !== CH.view.end) {
            CH.view.end = end;
            CH.hover = null; hideTip(); chartDraw();
          }
        }
      }
    });

    const finish = e => {
      const tapped = CH.tap && CH.drag && CH.drag.moved < 6 && Date.now() - CH.tap.t < 450;
      CH.ptrs.delete(e.pointerId);
      if (CH.ptrs.size < 2) CH.pinch = null;
      if (CH.ptrs.size === 0) {
        if (tapped) {
          const now = Date.now();
          if (now - CH.lastTap < 320) { CH.lastTap = 0; chartReset(); }
          else {
            CH.lastTap = now;
            const G = chartGeom();
            const x = relX(e), y = relY(e);
            const i = chartIndexAt(x);
            if (i >= G.start && i < G.end && x >= G.padL && x <= G.padL + G.plotW) {
              CH.hover = { i, y: Math.max(G.padT, Math.min(G.padT + G.priceH, y)) };
              showTip(i, x, y);
              chartDraw();
            }
          }
        }
        CH.drag = null; CH.tap = null;
      }
    };
    cv.addEventListener("pointerup", finish);
    cv.addEventListener("pointercancel", e => {
      CH.ptrs.delete(e.pointerId);
      CH.pinch = null; CH.drag = null; CH.tap = null;
    });
    cv.addEventListener("pointerleave", () => {
      if (!CH.ptrs.size) { CH.hover = null; hideTip(); chartDraw(); }
    });
  }

  function bindChartUI() {
    const bar = $("#chBar");
    if (!bar || bar.dataset.bound) return;
    bar.dataset.bound = "1";
    bar.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      const N = CH.rows.length;
      if (b.dataset.rng) {
        const n = Math.min(N, Number(b.dataset.rng));
        CH.view = { n: Math.max(Math.min(20, N), n), end: N };
        CH.hover = null; hideTip(); chartDraw();
      } else if (b.id === "chZi") chartZoom(0.72, CH.padL + (CH.cssW - CH.padL - CH.padR) / 2);
      else if (b.id === "chZo") chartZoom(1.38, CH.padL + (CH.cssW - CH.padL - CH.padR) / 2);
      else if (b.id === "chRs") chartReset();
    });
    const leg = $("#chLeg");
    if (leg && !leg.dataset.bound) {
      leg.dataset.bound = "1";
      leg.addEventListener("click", e => {
        const b = e.target.closest("button");
        if (!b || !b.dataset.ch) return;
        const k = b.dataset.ch;
        CH.opts[k] = CH.opts[k] ? 0 : 1;
        LS.set("krt.chart", CH.opts);
        CH.hover = null; hideTip();
        syncChBtns();
        chartDraw();
      });
    }
  }

  /* ─────────────────────────── 필터 UI ─────────────────────────── */
  const DAY_MAX = 99;

  function syncFilters() {
    $$("#filters .chip[data-market]").forEach(c => c.classList.toggle("on", c.dataset.market === state.market));
    $$("#filters .chip[data-r]").forEach(c => c.classList.toggle("on", Number(c.dataset.r) === state.rMin));
    $$("#filters .chip[data-ch]").forEach(c => c.classList.toggle("on", (c.dataset.ch || "") === state.chart));
    $$("#filters .chip[data-tr]").forEach(c => c.classList.toggle("on", c.dataset.tr === state.trend));
    $$("#filters .chip[data-pm]").forEach(c => c.classList.toggle("on", Number(c.dataset.pm) === state.perMax));
    $("#both").classList.toggle("on", state.both);
    const groups = [["fp", "fMin", "#inF", "#wF"], ["op", "oMin", "#inO", "#wO"], ["pp", "pMin", "#inP", "#wP"]];
    groups.forEach(([attr, key, inSel, wrapSel]) => {
      const v = state[key];
      $$(`#filters .chip[data-${attr}]`).forEach(c => c.classList.toggle("on", Number(c.dataset[attr]) === v));
      const el = $(inSel);
      if (el && el.value !== "" && Number(el.value) !== v) el.value = v || "";
      if (el && v && el.value === "") el.value = v;
      $(wrapSel).classList.toggle("on", v > 0);
    });
  }

  function setDays(key, v) {
    v = Math.max(0, Math.min(DAY_MAX, Number(v) || 0));
    state[key] = v;
    state.limit = 120;
    syncFilters();
    renderTable();
  }

  function bindDays(inSel, key) {
    const el = $(inSel);
    if (!el) return;
    const commit = () => setDays(key, el.value);
    el.addEventListener("input", debounce(commit, 220));
    el.addEventListener("change", commit);
    el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); commit(); el.blur(); } });
  }

  function resetFilters() {
    state.market = "ALL"; state.fMin = 0; state.oMin = 0; state.pMin = 0; state.rMin = 0;
    state.chart = ""; state.both = false; state.q = ""; state.limit = 120;
    state.trend = "both"; state.perMax = 1.5;
    $("#q").value = ""; $("#qclear").classList.remove("show");
    ["#inF", "#inO", "#inP"].forEach(s => { const el = $(s); if (el) el.value = ""; });
    syncFilters();
    renderTable();
  }

  /* ─────────────────────────── 이벤트 ─────────────────────────── */
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function bind() {
    $("#tabs").addEventListener("click", e => {
      const b = e.target.closest(".tab"); if (!b) return;
      $$(".tab").forEach(x => x.classList.toggle("active", x === b));
      state.tab = b.dataset.tab;
      state.limit = 120;
      const defaults = { all: ["va", -1], foreign: ["fv", -1], inst: ["oq", -1], rose: ["chp", -1], lowper: ["per", 1], mine: ["chp", -1] };
      const [k, d] = defaults[state.tab] || ["va", -1];
      state.sort = { key: k, dir: d };
      document.body.classList.toggle("rose", state.tab === "rose");
      document.body.classList.toggle("lp", state.tab === "lowper");
      setTabClass();
      renderTable();
    });

    $("#filters").addEventListener("click", e => {
      const c = e.target.closest(".chip");
      if (c && c.dataset.market) {
        state.market = c.dataset.market;
      } else if (c && c.dataset.r !== undefined) {
        state.rMin = Number(c.dataset.r);
      } else if (c && c.dataset.fp !== undefined) {
        state.fMin = Number(c.dataset.fp);
        $("#inF").value = state.fMin || "";
      } else if (c && c.dataset.op !== undefined) {
        state.oMin = Number(c.dataset.op);
        $("#inO").value = state.oMin || "";
      } else if (c && c.dataset.pp !== undefined) {
        state.pMin = Number(c.dataset.pp);
        $("#inP").value = state.pMin || "";
      } else if (c && c.dataset.ch !== undefined) {
        state.chart = c.dataset.ch;
      } else if (c && c.dataset.tr !== undefined) {
        state.trend = c.dataset.tr;
      } else if (c && c.dataset.pm !== undefined) {
        state.perMax = Number(c.dataset.pm);
      } else if (c && c.id === "both") {
        state.both = !state.both;
      }
      state.limit = 120;
      syncFilters();
      renderTable();
    });

    bindDays("#inF", "fMin");
    bindDays("#inO", "oMin");
    bindDays("#inP", "pMin");

    $("#reset").addEventListener("click", resetFilters);

    $("#q").addEventListener("input", debounce(e => {
      state.q = e.target.value;
      state.limit = 120;
      $("#qclear").classList.toggle("show", !!state.q);
      renderTable();
    }, 120));
    $("#qclear").addEventListener("click", () => {
      state.q = ""; $("#q").value = ""; $("#qclear").classList.remove("show"); renderTable();
    });

    $("#tsort").addEventListener("click", e => {
      const b = e.target.closest("button[data-quick]"); if (!b) return;
      const k = b.dataset.quick;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 };
      renderTable();
    });

    $("#tbl").addEventListener("click", e => {
      const th = e.target.closest("th.sortable");
      if (th) {
        const k = th.dataset.sort;
        state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 };
        renderTable(); return;
      }
      const tr = e.target.closest("tr[data-code]");
      if (tr) openDetail(tr.dataset.code);
    });

    $("#more").addEventListener("click", () => { state.limit += 200; renderTable(); });
    $("#dClose").addEventListener("click", closeDetail);
    $("#scrim").addEventListener("click", closeDetail);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") closeDetail();
      if (e.key === "/" && document.activeElement !== $("#q") && !/^INPUT|TEXTAREA$/.test((document.activeElement || {}).tagName || "")) {
        e.preventDefault(); $("#q").focus();
      }
    });
    window.addEventListener("resize", debounce(() => {
      if (state.openCode && $("#chart") && CH.rows.length) {
        chartResize();
        chartDraw();
      }
    }, 200));
  }

  function setTabClass() {
    document.body.className = document.body.className
      .split(/\s+/).filter(c => c && !/^t-/.test(c)).join(" ");
    document.body.classList.add("t-" + state.tab);
  }

  function closeDetail() {
    $("#drawer").hidden = true;
    document.body.style.overflow = "";
    state.openCode = null;
    renderTable();
  }

  bind();
  syncFilters();
  setTabClass();
  boot();
})();
