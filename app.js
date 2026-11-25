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
    fMin: 0,
    pMin: 0,
    rMin: 0,
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
      renderTable();
      $("#cntAll").textContent = nf.format(d.stocks.length);
      $("#cntRose").textContent = nf.format(d.stocks.filter(s => s.pchp > 0).length);
      $("#cntMine").textContent = state.watch.size;
      $("#srcline").insertAdjacentHTML("afterbegin", "");
    } catch (e) {
      $("#tinfo").innerHTML = '<span class="down">데이터를 불러오지 못했습니다 — ' + e.message + "</span>";
      $("#stamp").textContent = "오프라인";
    }
  }

  function renderStamp() {
    const d = state.data;
    if (!d) return;
    const g = new Date(d.generatedAt);
    const t = g.toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const fd = d.flowDate ? d.flowDate.slice(4, 6) + "/" + d.flowDate.slice(6, 8) : "–";
    const st = (d.indices && d.indices.KOSPI && d.indices.KOSPI.status) === "OPEN" ? "장중" : "장마감";
    $("#stamp").textContent = `갱신 ${t} · ${st} · 외인수급 ${fd} 기준 · ${nf.format(d.counts.total)}종목`;
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
  function filtered() {
    const { data } = state;
    if (!data) return [];
    const q = state.q.trim().toLowerCase();
    let arr = data.stocks;
    if (state.market !== "ALL") arr = arr.filter(s => s.m === state.market);
    if (state.fMin) arr = arr.filter(s => s.fc >= state.fMin);
    if (state.pMin) arr = arr.filter(s => s.pc >= state.pMin);
    if (q) {
      arr = arr.filter(s => s.n.toLowerCase().includes(q) || s.c.includes(q));
    }
    if (state.tab === "foreign") {
      arr = arr.filter(s => (s.fq > 0 || s.fv > 0));
    }
    if (state.tab === "rose") {
      // 직전 거래일에 상승 마감한 종목만 (pchp: 전일 등락률)
      arr = arr.filter(s => s.pchp !== null && s.pchp !== undefined && s.pchp > 0);
      if (state.rMin) arr = arr.filter(s => s.pchp >= state.rMin);
    }
    if (state.tab === "mine") {
      arr = arr.filter(s => state.watch.has(s.c));
    }
    const k = state.sort.key, dir = state.sort.dir;
    arr = arr.slice().sort((a, b) => {
      const av = a[k], bv = b[k];
      const an = av === null || av === undefined ? -Infinity : av;
      const bn = bv === null || bv === undefined ? -Infinity : bv;
      if (typeof an === "string") return dir * an.localeCompare(bn);
      return dir * (an - bn);
    });
    return arr;
  }

  const COLS = {
    all: [["va", "거래대금"], ["mc", "시가총액"], ["chp", "등락률"], ["fv", "외인금액"]],
    foreign: [["fv", "외인금액"], ["fq", "순매수주수"], ["fc", "연속일수"], ["va", "거래대금"]],
    filter: [["fc", "외인연속"], ["pc", "상승연속"], ["fv", "외인금액"], ["chp", "등락률"]],
    rose: [["chp", "오늘 등락률"], ["pchp", "전일 등락률"], ["c2d", "2일 누적"], ["fc", "외인연속"]],
    mine: [["chp", "등락률"], ["fv", "외인금액"], ["r20", "20일 수익률"]]
  };

  function maBadges(s) {
    const b = (label, key) => {
      const v = s[key];
      if (v == null) return `<i class="n" title="${label}일선 데이터 없음">${label}</i>`;
      const ok = s.p >= v;
      return `<i class="${ok ? "y" : "x"}" title="${label}일선 ${fmt(v)} · ${ok ? "위" : "아래"}">${label}</i>`;
    };
    return `<div class="mas">${b("5", "ma5")}${b("20", "ma20")}${b("60", "ma60")}${b("200", "ma200")}</div>`;
  }

  function rowHtml(s) {
    const c = cls(s.chp);
    const fc = s.fc;
    const fcAmt = (state.tab === "foreign" && s.fvc) ? ` · ${won(s.fvc)}` : "";
    const fcPill = fc ? `<span class="pill ${fc > 0 ? "f" : "o"}">외인 ${fc > 0 ? fc + "일↑" : Math.abs(fc) + "일↓"}${fcAmt}</span>`
      : '<span class="pill n">–</span>';
    const pc = s.pc;
    const pcPill = pc ? `<span class="pill ${pc > 0 ? "f" : "o"}">${pc > 0 ? pc + "일↑" : Math.abs(pc) + "일↓"}</span>`
      : '<span class="pill n">–</span>';
    const star = state.watch.has(s.c) ? '<span style="color:#f5c451">★</span>' : "";
    const chAmt = s.ch != null ? (s.ch > 0 ? "+" : "") + nf.format(s.ch) : "–";
    return `<tr data-code="${s.c}">
      <td class="c-name"><div class="nm">${star}${s.n}<span class="code">${s.c}</span><span class="mkt ${s.m}">${s.m === "K" ? "코스피" : "코스닥"}</span></div></td>
      <td data-k="p" class="mono">${fmt(s.p)}</td>
      <td data-k="chp" class="${c} mono">${chAmt} ${signedTxt(s.chp)}</td>
      <td data-k="pchp" class="roseonly ${cls(s.pchp)} mono">${signedTxt(s.pchp)}</td>
      <td data-k="c2d" class="roseonly ${cls(s.c2d)} mono">${signedTxt(s.c2d)}</td>
      <td data-k="fv" class="${cls(s.fv)} mono">${won(s.fv)}</td>
      <td data-k="fq" class="${cls(s.fq)} mono">${s.fq ? nf.format(s.fq) : "–"}</td>
      <td data-k="fc">${fcPill}</td>
      <td data-k="pc">${pcPill}</td>
      <td data-k="va" class="hide-sm mono">${won(s.va)}</td>
      <td data-k="ma" class="hide-sm">${maBadges(s)}</td>
      <td data-k="r20" class="hide-sm ${cls(s.r20)} mono">${signedTxt(s.r20, 1)}</td>
    </tr>`;
  }

  function renderTable() {
    const arr = filtered();
    const shown = arr.slice(0, state.limit);
    $("#tbody").innerHTML = shown.map(rowHtml).join("");
    $("#empty").hidden = arr.length !== 0;
    $("#more").hidden = arr.length <= state.limit;
    if (arr.length > state.limit) $("#more").textContent = `더 보기 (${nf.format(arr.length - state.limit)}개 남음)`;

    const base = {
      all: "전 종목", foreign: "외국인 순매수 상위", filter: "조건 교집합",
      rose: "전일 상승 → 오늘", mine: "내 종목"
    }[state.tab];
    const bits = [];
    if (state.market !== "ALL") bits.push(state.market === "K" ? "코스피" : "코스닥");
    if (state.rMin && state.tab === "rose") bits.push(`전일 +${state.rMin}%↑`);
    if (state.fMin) bits.push(`외인 ${state.fMin}일+`);
    if (state.pMin) bits.push(`${state.pMin}일+ 상승`);
    if (state.q) bits.push(`"${state.q}"`);
    $("#tinfo").innerHTML = `<b>${nf.format(arr.length)}</b>종목 · ${base}${bits.length ? " · " + bits.join(" · ") : ""}` +
      (state.data && state.data.flowDate ? ` <span style="color:#63708a">(외인수급 ${state.data.flowDate.slice(4, 6)}/${state.data.flowDate.slice(6, 8)})</span>` : "");

    const cols = COLS[state.tab] || COLS.all;
    $("#tsort").innerHTML = cols.map(([k, l]) =>
      `<button data-quick="${k}" class="${state.sort.key === k ? "on" : ""}">${l}</button>`).join("");

    $$("#tbl thead th").forEach(th => {
      th.classList.toggle("sorted", th.dataset.sort === state.sort.key);
      th.classList.toggle("asc", th.dataset.sort === state.sort.key && state.sort.dir === 1);
    });
    renderRoseSum();
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
    renderDetail(s, rows || []);
  }

  function paintHeader(s) {
    const c = cls(s.chp);
    $("#dPrice").textContent = fmt(s.p);
    $("#dPrice").className = c;
    $("#dChg").className = c;
    $("#dChg").textContent = `${s.ch != null ? (s.ch > 0 ? "+" : "") + nf.format(s.ch) : "–"} (${signedTxt(s.chp)})`;
  }

  function renderDetail(s, rows) {
    const maLine = [["ma5", "5일"], ["ma20", "20일"], ["ma60", "60일"], ["ma200", "200일"]]
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
    if (s.pc) consec.push(`<span class="pill ${s.pc > 0 ? "f" : "o"}">${Math.abs(s.pc)}일 연속 ${s.pc > 0 ? "상승" : "하락"}</span>`);
    if (s.fqc) consec.push(`<span class="pill n">누적 ${nf.format(s.fqc)}주 ${s.fvc ? "· " + won(s.fvc) : ""}</span>`);

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
        <h3>차트 (일봉 · 최근 ${rows.length}거래일)</h3>
        <canvas id="chart" height="230"></canvas>
        <div class="legend">
          <span><i style="background:#f6465d"></i>상승</span>
          <span><i style="background:#3b82f6"></i>하락</span>
          <span><i style="background:#22d3ee"></i>MA5</span>
          <span><i style="background:#f5a524"></i>MA20</span>
          <span><i style="background:#a78bfa"></i>MA60</span>
          <span><i style="background:#63708a"></i>MA200</span>
        </div>
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

    drawChart($("#chart"), rows, s);
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
      $("#cntMine").textContent = state.watch.size;
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
      $("#cntMine").textContent = state.watch.size;
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

  /* ─────────────────────────── 차트 ─────────────────────────── */
  function drawChart(cv, rows, s) {
    if (!cv || !rows.length) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 480, cssH = 230;
    cv.width = cssW * dpr; cv.height = cssH * dpr;
    cv.style.height = cssH + "px";
    const g = cv.getContext("2d");
    g.scale(dpr, dpr);
    g.clearRect(0, 0, cssW, cssH);

    const padL = 4, padR = 44, padT = 8, volH = 46, padB = 18;
    const W = cssW - padL - padR, H = cssH - padT - padB - volH;
    const closes = rows.map(r => r[4]);
    const maSeries = (n) => closes.map((_, i) => i < n - 1 ? null : closes.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n);
    const mas = { 5: maSeries(5), 20: maSeries(20), 60: maSeries(60) };

    let lo = Math.min(...rows.map(r => r[3]));
    let hi = Math.max(...rows.map(r => r[2]));
    Object.values(mas).forEach(ser => ser.forEach(v => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
    if (s.ma200 != null) { lo = Math.min(lo, s.ma200); hi = Math.max(hi, s.ma200); }
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const X = i => padL + (W / rows.length) * (i + 0.5);
    const Y = v => padT + H - ((v - lo) / (hi - lo)) * H;
    const bw = Math.max(1.4, (W / rows.length) * 0.62);

    // grid
    g.strokeStyle = "#18202b"; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (H / 4) * i;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + W, y); g.stroke();
      g.fillStyle = "#4a5666"; g.font = "9px system-ui"; g.textAlign = "left";
      g.fillText(nf.format(Math.round(hi - ((hi - lo) / 4) * i)), padL + W + 5, y + 3);
    }

    // candles
    rows.forEach((r, i) => {
      const [, o, h, l, c] = r;
      const up = c >= o;
      g.strokeStyle = g.fillStyle = up ? "#f6465d" : "#3b82f6";
      g.lineWidth = 1;
      const x = X(i);
      g.beginPath(); g.moveTo(x, Y(h)); g.lineTo(x, Y(l)); g.stroke();
      const y1 = Y(Math.max(o, c)), y2 = Y(Math.min(o, c));
      g.fillRect(x - bw / 2, y1, bw, Math.max(1.2, y2 - y1));
    });

    // MA200 dashed
    if (s.ma200 != null && s.ma200 > lo && s.ma200 < hi) {
      g.strokeStyle = "rgba(99,112,138,.85)"; g.setLineDash([4, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, Y(s.ma200)); g.lineTo(padL + W, Y(s.ma200)); g.stroke();
      g.setLineDash([]);
    }
    // MA lines
    [[5, "#22d3ee"], [20, "#f5a524"], [60, "#a78bfa"]].forEach(([n, col]) => {
      g.strokeStyle = col; g.lineWidth = 1.4; g.beginPath();
      let started = false;
      mas[n].forEach((v, i) => {
        if (v == null) return;
        const x = X(i), y = Y(v);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      });
      g.stroke();
    });

    // volume
    const vmax = Math.max(...rows.map(r => r[5] || 0)) || 1;
    const vTop = padT + H + 10;
    rows.forEach((r, i) => {
      const up = r[4] >= r[1];
      const h = ((r[5] || 0) / vmax) * (volH - 12);
      g.fillStyle = up ? "rgba(246,70,93,.45)" : "rgba(59,130,246,.45)";
      g.fillRect(X(i) - bw / 2, vTop + (volH - 12) - h, bw, h);
    });

    // 날짜 눈금
    g.fillStyle = "#4a5666"; g.font = "9px system-ui";
    const dd = i => rows[i][0].slice(4, 6) + "/" + rows[i][0].slice(6, 8);
    const ly = cssH - 3;
    g.textAlign = "left"; g.fillText(dd(0), padL, ly);
    g.textAlign = "center"; g.fillText(dd(Math.floor(rows.length / 2)), padL + W / 2, ly);
    g.textAlign = "right"; g.fillText(dd(rows.length - 1), padL + W, ly);

    // last price tag
    const lastY = Y(s.p || closes[closes.length - 1]);
    g.fillStyle = "#4da3ff"; g.fillRect(padL + W + 1, lastY - 7, padR - 2, 14);
    g.fillStyle = "#04121f"; g.font = "600 9.5px system-ui"; g.textAlign = "left";
    g.fillText(nf.format(s.p || closes[closes.length - 1]), padL + W + 4, lastY + 3.4);
  }

  /* ─────────────────────────── 이벤트 ─────────────────────────── */
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function bind() {
    $("#tabs").addEventListener("click", e => {
      const b = e.target.closest(".tab"); if (!b) return;
      $$(".tab").forEach(x => x.classList.toggle("active", x === b));
      state.tab = b.dataset.tab;
      state.limit = 120;
      const defaults = { all: ["va", -1], foreign: ["fv", -1], filter: ["fc", -1], rose: ["chp", -1], mine: ["pnl", -1] };
      const [k, d] = defaults[state.tab] || ["va", -1];
      state.sort = { key: k, dir: d };
      document.body.classList.toggle("rose", state.tab === "rose");
      if (state.tab === "mine" && state.sort.key === "pnl") state.sort = { key: "chp", dir: -1 };
      if (state.tab === "mine") state.sort = { key: "chp", dir: -1 };
      renderTable();
    });

    $("#filters").addEventListener("click", e => {
      const c = e.target.closest(".chip");
      if (c && c.dataset.market) {
        state.market = c.dataset.market;
        $$("#filters .chip[data-market]").forEach(x => x.classList.toggle("on", x === c));
      } else if (c && c.dataset.f !== undefined) {
        state.fMin = Number(c.dataset.f);
        $$("#filters .chip[data-f]").forEach(x => x.classList.toggle("on", x === c));
      } else if (c && c.dataset.p !== undefined) {
        state.pMin = Number(c.dataset.p);
        $$("#filters .chip[data-p]").forEach(x => x.classList.toggle("on", x === c));
      } else if (c && c.dataset.r !== undefined) {
        state.rMin = Number(c.dataset.r);
        $$("#filters .chip[data-r]").forEach(x => x.classList.toggle("on", x === c));
      }
      state.limit = 120; renderTable();
    });

    $("#reset").addEventListener("click", () => {
      state.market = "ALL"; state.fMin = 0; state.pMin = 0; state.rMin = 0; state.q = ""; state.limit = 120;
      $("#q").value = ""; $("#qclear").classList.remove("show");
      $$("#filters .chip").forEach(c => {
        if (c.dataset.market) c.classList.toggle("on", c.dataset.market === "ALL");
        if (c.dataset.f !== undefined) c.classList.toggle("on", c.dataset.f === "0");
        if (c.dataset.p !== undefined) c.classList.toggle("on", c.dataset.p === "0");
        if (c.dataset.r !== undefined) c.classList.toggle("on", c.dataset.r === "0");
      });
      renderTable();
    });

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
      if (e.key === "/" && document.activeElement !== $("#q")) { e.preventDefault(); $("#q").focus(); }
    });
    window.addEventListener("resize", debounce(() => {
      if (state.openCode && $("#chart")) {
        const s = state.byCode.get(state.openCode);
        const rows = state.hcache.get(state.openCode) || [];
        if (s) drawChart($("#chart"), rows, s);
      }
    }, 200));
  }

  function closeDetail() {
    $("#drawer").hidden = true;
    document.body.style.overflow = "";
    state.openCode = null;
    renderTable();
  }

  bind();
  boot();
})();
