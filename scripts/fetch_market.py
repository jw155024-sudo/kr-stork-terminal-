#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
국내 주식 전 종목 터미널 - 데이터 수집기

수집 소스
  * m.stock.naver.com/api/stocks/marketValue/{KOSPI|KOSDAQ} : 전 종목 시세/시총 스냅샷
  * m.stock.naver.com/api/stock/{code}/trend             : 일별 외국인/기관/개인 순매수 (최근 60거래일)
  * m.stock.naver.com/api/stock/{code}/integration       : PER/PBR/EPS/BPS 등 투자지표 (PBR용)
  * api.finance.naver.com/siseJson.naver                 : 일별 OHLCV + 외국인소진율 (최근 약 1년)
  * m.stock.naver.com/api/index/{KOSPI|KOSDAQ}/integration : 지수 + 투자자별 수급 + 상승/하락 종목수
  * query1.finance.yahoo.com/v8/finance/chart            : 환율/나스닥선물/SOX/SOXX·SOXL·SOXS

산출물
  data/market.json        목록용 (전 종목 요약 + 지수/매크로)
  data/h/{코드앞2자리}.json 종목 상세용 (최근 40거래일 OHLCV + 수급)
  data/meta.json          수집 상태
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
HDIR = os.path.join(DATA, "h")
KST = timezone(timedelta(hours=9))

UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
UA_DESKTOP = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

WORKERS = int(os.environ.get("FETCH_WORKERS", "20"))
PBR_WORKERS = int(os.environ.get("PBR_WORKERS", "24"))   # PBR 수집 전용 병렬도
HIST_DAYS = 60          # 상세 화면용 일별 데이터 보관 거래일 수
FLOW_WINDOW = 30        # 연속 매수 계산에 쓰는 최대 거래일

# NXT(넥스트레이드) 프리·애프터마켓 표시 시간대 (KST, 분 단위)
NXT_PRE_FROM, NXT_PRE_TO = 8 * 60, 9 * 60            # 프리 08:00~08:50, 09:00 정규장 개장
NXT_AFTER_FROM = 15 * 60 + 40                        # 애프터 15:40~20:00 (마감 뒤에도 당일 마지막 시세 유지)


# ---------------------------------------------------------------- http helpers
def http_get(url: str, timeout: int = 25, headers: dict | None = None) -> bytes:
    h = {"User-Agent": UA_DESKTOP if "finance.naver.com" in url else UA,
         "Accept": "application/json, text/plain, */*",
         "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"}
    if headers:
        h.update(headers)
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.6 * (attempt + 1))
    raise last  # type: ignore[misc]


def num(v, default=None):
    """'170,000' / '+2,348,072' / '-' / '' -> int/float"""
    if v is None:
        return default
    if isinstance(v, (int, float)):
        return v
    s = str(v).strip().replace(",", "").replace("+", "")
    if s in ("", "-", "N/A", "nan"):
        return default
    try:
        return int(float(s)) if re.fullmatch(r"-?\d+(\.0+)?", s) else float(s)
    except ValueError:
        return default


def pct(v, default=None):
    n = num(str(v).replace("%", "")) if v is not None else None
    return default if n is None else float(n)


# ------------------------------------------------------------------- markets
def over_market_quote(s: dict, now: datetime) -> dict | None:
    """NXT 프리/애프터마켓 체결가(overMarketPriceInfo) 중 지금 보여야 할 값을 고른다.

    네이버의 marketStatus는 정규장이 끝난 뒤에도 NXT 세션이 열려 있는 종목은 'OPEN'으로
    남아 있다(ETF·ETN처럼 NXT 미지원 종목만 'CLOSE'). 그래서 정규장 여부 판단에는 쓰지 않고
    세션 종류(프리/애프터)·체결 시각(당일 여부)·현재 KST 시각으로 판정한다.
    """
    o = s.get("overMarketPriceInfo")
    if not isinstance(o, dict):
        return None
    session = str(o.get("tradingSessionType") or "").upper()
    price = num(o.get("overPriceRaw"), num(o.get("overPrice")))
    if not price or price <= 0:
        return None
    if "PRE" in session:
        label, ok = "프리", NXT_PRE_FROM <= now.hour * 60 + now.minute < NXT_PRE_TO
    elif "AFTER" in session:
        label, ok = "애프터", now.hour * 60 + now.minute >= NXT_AFTER_FROM
    else:
        return None
    traded = str(o.get("localTradedAt") or "")
    # 당일 세션 체결분만 쓴다(전일·휴장일 애프터 시세로 오인하지 않도록)
    if not traded.startswith(now.strftime("%Y-%m-%d")) or not ok:
        return None
    return {
        "label": label,
        "price": price,
        "change": num(o.get("compareToPreviousClosePriceRaw"),
                      num(o.get("compareToPreviousClosePrice"))),
        "chgPct": pct(o.get("fluctuationsRatio")),
        "tradedAt": traded,
        "sessionStatus": o.get("overMarketStatus"),
    }


def fetch_universe() -> list[dict]:
    """코스피 + 코스닥 전 종목 시세 스냅샷."""
    out: list[dict] = []
    now = datetime.now(KST)
    for market in ("KOSPI", "KOSDAQ"):
        url = lambda p: (f"https://m.stock.naver.com/api/stocks/marketValue/{market}"
                         f"?page={p}&pageSize=100")
        first = json.loads(http_get(url(1)))
        total = first.get("totalCount", 0)
        pages = max(1, (total + 99) // 100)
        payloads = {1: first}

        def grab(p):
            try:
                return p, json.loads(http_get(url(p)))
            except Exception:  # noqa: BLE001
                return p, None

        with ThreadPoolExecutor(max_workers=8) as ex:
            for p, d in ex.map(grab, range(2, pages + 1)):
                if d:
                    payloads[p] = d
        for page in sorted(payloads):
            d = payloads[page]
            stocks = d.get("stocks") or []
            if not stocks:
                continue
            for s in stocks:
                if s.get("stockEndType") != "stock":
                    continue
                row = {
                    "code": s.get("itemCode"),
                    "name": s.get("stockName"),
                    "market": market,
                    "price": num(s.get("closePriceRaw"), num(s.get("closePrice"))),
                    "change": num(s.get("compareToPreviousClosePriceRaw"),
                                  num(s.get("compareToPreviousClosePrice"))),
                    "chgPct": pct(s.get("fluctuationsRatio")),
                    "volume": num(s.get("accumulatedTradingVolumeRaw"), 0),
                    "value": num(s.get("accumulatedTradingValueRaw"), 0),
                    "mcap": num(s.get("marketValueRaw"), 0),
                    "status": s.get("marketStatus"),
                    "tradedAt": s.get("localTradedAt"),
                }
                # 프리/애프터 시세가 유효하면 정규장 스냅샷을 덮어쓰고 표시용 라벨을 남긴다.
                q = over_market_quote(s, now)
                if q:
                    row["regPrice"] = row["price"]
                    row["price"] = q["price"]
                    row["change"] = q["change"]
                    row["chgPct"] = q["chgPct"]
                    row["tradedAt"] = q["tradedAt"]
                    row["nxt"] = q["label"]
                out.append(row)
    # 코드 중복 제거
    seen = {}
    for s in out:
        seen[s["code"]] = s
    return list(seen.values())


def fetch_indices() -> dict:
    res = {}
    for idx in ("KOSPI", "KOSDAQ"):
        try:
            b = json.loads(http_get(f"https://m.stock.naver.com/api/index/{idx}/basic"))
            d = json.loads(http_get(f"https://m.stock.naver.com/api/index/{idx}/integration"))
            info = {i.get("code"): i.get("value") for i in d.get("totalInfos", [])}
            deal = d.get("dealTrendInfo") or {}
            up = d.get("upDownStockInfo") or {}
            res[idx] = {
                "name": "코스피" if idx == "KOSPI" else "코스닥",
                "price": num(b.get("closePrice")),
                "change": num(b.get("compareToPreviousClosePrice")),
                "chgPct": pct(b.get("fluctuationsRatio")),
                "volume": info.get("accumulatedTradingVolume"),
                "value": info.get("accumulatedTradingValue"),
                "status": b.get("marketStatus"),
                "tradedAt": b.get("localTradedAt"),
                "dealDate": deal.get("bizdate"),
                "personal": num(deal.get("personalValue")),
                "foreign": num(deal.get("foreignValue")),
                "institution": num(deal.get("institutionalValue")),
                "rise": num(up.get("riseCount"), 0),
                "fall": num(up.get("fallCount"), 0),
                "upper": num(up.get("upperCount"), 0),
                "lower": num(up.get("lowerCount"), 0),
            }
        except Exception as e:  # noqa: BLE001
            res[idx] = {"error": str(e)[:120]}
    return res


YAHOO_SYMBOLS = [
    ("USDKRW", "원/달러", "KRW=X", "fx"),
    ("NQ", "나스닥100 선물", "NQ=F", "future"),
    ("SOX", "필라델피아 반도체", "^SOX", "index"),
    ("SOXX", "SOXX", "SOXX", "etf"),
    ("SOXL", "SOXL", "SOXL", "etf"),
    ("SOXS", "SOXS", "SOXS", "etf"),
]


def _yahoo_one(symbol: str):
    for host in ("query1", "query2"):
        url = (f"https://{host}.finance.yahoo.com/v8/finance/chart/"
               f"{urllib.parse.quote(symbol)}?interval=1d&range=5d")
        try:
            raw = json.loads(http_get(url, headers={"User-Agent": UA_DESKTOP}))
            r = (raw.get("chart") or {}).get("result") or []
            if not r:
                continue
            meta = r[0].get("meta") or {}
            price = meta.get("regularMarketPrice")
            prev = meta.get("chartPreviousClose") or meta.get("previousClose")
            if price is None:
                continue
            chg = None if prev in (None, 0) else float(price) - float(prev)
            chgp = None if chg is None else chg / float(prev) * 100
            return {"price": round(float(price), 4),
                    "change": None if chg is None else round(chg, 4),
                    "chgPct": None if chgp is None else round(chgp, 2),
                    "currency": meta.get("currency"),
                    "time": meta.get("regularMarketTime")}
        except Exception:  # noqa: BLE001
            continue
    return None


def fetch_macro(prev: dict | None = None) -> list[dict]:
    prev = prev or {}
    res = []
    got_all = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for (key, label, sym, kind), got in zip(YAHOO_SYMBOLS, ex.map(_yahoo_one, [s[2] for s in YAHOO_SYMBOLS])):
            got_all[key] = got
    for key, label, sym, kind in YAHOO_SYMBOLS:
        item = {"key": key, "label": label, "symbol": sym, "kind": kind}
        got = got_all.get(key)
        if got:
            item.update(got)
            item["stale"] = False
        else:
            old = (prev.get(key) or {})
            item.update({k: old.get(k) for k in ("price", "change", "chgPct")})
            item["stale"] = True
        res.append(item)
    return res


# --------------------------------------------------------------- per stock
def fetch_hist(code: str, start: str, end: str) -> list[list]:
    url = (f"https://api.finance.naver.com/siseJson.naver?symbol={code}"
           f"&requestType=1&startTime={start}&endTime={end}&timeframe=day")
    txt = http_get(url).decode("utf-8", "replace")
    rows = re.findall(
        r'\["(\d{8})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\]',
        txt)
    out = []
    for d, o, h, l, c, v, fr in rows:
        out.append([d, num(o), num(h), num(l), num(c), num(v), pct(fr)])
    return out


def fetch_pbr(code: str) -> float | None:
    """PBR(배). 네이버 종목 통합 API의 투자지표에서 읽는다.

    결측/0 이하/N/A는 None. 값은 최근 결산 기준 BPS 대비 현재가 비율이라
    매일 가격에 따라 조금씩 움직인다.
    """
    try:
        d = json.loads(http_get(f"https://m.stock.naver.com/api/stock/{code}/integration"))
    except Exception:  # noqa: BLE001
        return None
    for info in d.get("totalInfos") or []:
        if info.get("code") != "pbr":
            continue
        s = str(info.get("value") or "").replace(",", "").replace("배", "").strip()
        if s in ("", "-", "N/A", "nan"):
            return None
        try:
            v = float(s)
        except ValueError:
            return None
        return round(v, 2) if v > 0 else None
    return None


def fetch_trend(code: str) -> list[dict]:
    url = f"https://m.stock.naver.com/api/stock/{code}/trend?pageSize=60"
    arr = json.loads(http_get(url))
    out = []
    for r in arr or []:
        out.append({
            "date": r.get("bizdate"),
            "fp": num(r.get("foreignerPureBuyQuant")),      # 외국인 순매수(주)
            "op": num(r.get("organPureBuyQuant")),          # 기관
            "ip": num(r.get("individualPureBuyQuant")),     # 개인
            "close": num(r.get("closePrice")),
            "fratio": pct(r.get("foreignerHoldRatio")),
        })
    return out


def streak(series: list[float]):
    """연속 부호 일수. 마지막 값부터 거꾸로. (일수, 부호)"""
    if not series:
        return 0
    last = series[-1]
    if last is None or last == 0:
        return 0
    sign = 1 if last > 0 else -1
    n = 0
    for v in reversed(series):
        if v is None:
            break
        if (v > 0 and sign > 0) or (v < 0 and sign < 0):
            n += 1
        else:
            break
    return n * sign


def ma(closes: list[float], n: int):
    if len(closes) < n or n <= 0:
        return None
    seg = closes[-n:]
    if any(v is None for v in seg):
        return None
    return round(sum(seg) / n, 2)


def days_since_break(closes: list[float], n: int, lookback: int = 9):
    """n일선을 상향 돌파한 뒤 지난 거래일 수 (0 = 마지막 봉에서 돌파).

    장 시작 전이나 휴장일에는 b60·b120이 0건이 되므로, 최근 며칠 안에 돌파한
    '추세전환' 종목을 목록으로 보여주기 위해 쓴다. 없으면 None.
    """
    L = len(closes)
    for k in range(0, lookback + 1):
        i = L - 1 - k
        if i < n:
            break
        win = closes[i - n:i + 1]
        if any(v is None for v in win):
            continue
        ma_now = sum(closes[i - n + 1:i + 1]) / n
        ma_prev = sum(closes[i - n:i]) / n
        if closes[i - 1] <= ma_prev and closes[i] > ma_now:
            return k
    return None


def build_stock(row: dict, hist: list[list], trend: list[dict],
                pbr_val: float | None = None) -> dict:
    """개별 종목 계산. hist는 오래된→최신 순."""
    # --- 일별 흐름(최신순) 매핑
    trend = [t for t in trend if t.get("date")]
    trend.sort(key=lambda t: t["date"])            # 오래된→최신
    flow_dates = [t["date"] for t in trend]

    # --- 가격 시계열 (siseJson) : [date, o, h, l, c, v, fratio]
    hist = [h for h in hist if h and h[0]]
    hist.sort(key=lambda h: h[0])

    today = datetime.now(KST).strftime("%Y%m%d")
    closes = [h[4] for h in hist if h[4] is not None]
    if row.get("price") and hist and hist[-1][0] == today:
        closes[-1] = row["price"]

    # --- 연속 상승/하락
    price_consec = 0
    if len(closes) >= 2:
        diffs = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
        price_consec = streak(diffs)

    # --- 외국인/기관 연속 순매수 (최근 발표일 기준)
    fseries = [t.get("fp") or 0 for t in trend][-FLOW_WINDOW:]
    oseries = [t.get("op") or 0 for t in trend][-FLOW_WINDOW:]
    foreign_consec = streak(fseries)
    organ_consec = streak(oseries)

    # 최근 발표일 값 (당일 데이터가 아직 없으면 전일 확정치)
    flow_date = trend[-1]["date"] if trend else None
    fq = trend[-1].get("fp") if trend else None
    oq = trend[-1].get("op") if trend else None
    iq = trend[-1].get("ip") if trend else None
    flow_close = trend[-1].get("close") if trend else None
    fv = None
    if fq is not None and flow_close:
        fv = fq * flow_close

    # 연속 순매수 누적 (주, 금액)
    fcum_qty = 0
    if foreign_consec > 0:
        fcum_qty = sum(fseries[-foreign_consec:])
    elif foreign_consec < 0:
        fcum_qty = sum(fseries[-abs(foreign_consec):])
    fcum_val = None
    if fcum_qty and trend:
        # 각 일자 종가로 근사
        closes_by_date = {t["date"]: t.get("close") for t in trend}
        acc = 0.0
        n = abs(foreign_consec)
        for t in trend[-n:]:
            if t.get("fp") and t.get("close"):
                acc += t["fp"] * t["close"]
        fcum_val = acc or None

    # --- 이동평균선(60·120)과 '전일 대비 오늘 돌파' 판정
    #     오늘 봉이 아직 없으면(장 시작 전·휴장) 마지막 확정 종가 기준으로 계산한다.
    has_today = bool(row.get("price")) and bool(hist) and hist[-1][0] == today
    prev_series = closes[:-1] if has_today else closes
    prev_close = prev_series[-1] if prev_series else None
    ma60_v = ma(closes, 60)
    ma120_v = ma(closes, 120)
    pma60 = ma(prev_series, 60)
    pma120 = ma(prev_series, 120)
    px = row.get("price")
    b60 = b120 = a60 = a120 = None
    if px is not None:
        if ma60_v is not None:
            a60 = 1 if px > ma60_v else 0
            if prev_close is not None and pma60 is not None:
                b60 = 1 if (prev_close <= pma60 and px > ma60_v) else 0
        if ma120_v is not None:
            a120 = 1 if px > ma120_v else 0
            if prev_close is not None and pma120 is not None:
                b120 = 1 if (prev_close <= pma120 and px > ma120_v) else 0

    # --- 전일 등락률(직전 거래일 종가 / 전전일 종가) 과 2거래일 누적 등락률
    #     '오늘 등락률(chp)'은 시세 스냅샷 기준이므로, 누적은 두 일간 등락률을 복리로 합성한다.
    pchp = None
    if len(closes) >= 3 and closes[-1] is not None and closes[-2] is not None \
            and closes[-3] not in (None, 0):
        pchp = round((closes[-2] / closes[-3] - 1) * 100, 2)
    c2d = None
    if pchp is not None and row.get("chgPct") is not None:
        c2d = round(((1 + row["chgPct"] / 100) * (1 + pchp / 100) - 1) * 100, 2)

    st = {
        "c": row["code"],
        "n": row["name"],
        "m": "K" if row["market"] == "KOSPI" else "Q",
        "p": row.get("price"),
        "ch": row.get("change"),
        "chp": row.get("chgPct"),
        "v": row.get("volume"),
        "va": row.get("value"),
        "mc": row.get("mcap"),
        "fq": fq,
        "fv": int(fv) if fv is not None else None,
        "fc": foreign_consec,
        "fqc": int(fcum_qty) if fcum_qty else None,
        "fvc": int(fcum_val) if fcum_val else None,
        "oc": organ_consec,
        "oq": oq,
        "iq": iq,
        "pc": price_consec,
        "pchp": pchp,
        "c2d": c2d,
        "ma5": ma(closes, 5),
        "ma20": ma(closes, 20),
        "ma60": ma60_v,
        "ma120": ma120_v,
        "ma200": ma(closes, 200),
        "hi52": round(max(closes[-250:]), 2) if closes[-250:] else None,
        "lo52": round(min(closes[-250:]), 2) if closes[-250:] else None,
        "fd": flow_date,
        "fr": trend[-1].get("fratio") if trend else None,
    }
    # PBR (주가순자산비율). 유효값(>0)만 기록한다.
    if pbr_val is not None and pbr_val > 0:
        st["pbr"] = round(float(pbr_val), 2)
    # 지금 보여주는 가격이 NXT 프리/애프터 시세인지 표시용 라벨
    if row.get("nxt"):
        st["nxt"] = row["nxt"]
    # 이평선 돌파/위 여부 (b60·b120: 오늘 신규 돌파, a60·a120: 현재가가 선 위)
    for _k, _v in (("b60", b60), ("b120", b120), ("a60", a60), ("a120", a120)):
        if _v is not None:
            st[_k] = _v
    # 최근 9거래일 내 60·120일선 상향 돌파가 있었으면 그 뒤 지난 거래일 수(0=마지막 봉)
    x60 = days_since_break(closes, 60)
    x120 = days_since_break(closes, 120)
    if x60 is not None:
        st["x60"] = x60
    if x120 is not None:
        st["x120"] = x120

    # 지수 대비 20일 수익률 (차트용 아님, 목록 정렬용)
    if len(closes) >= 21 and closes[-21]:
        st["r20"] = round((closes[-1] / closes[-21] - 1) * 100, 2)
    if len(closes) >= 6 and closes[-6]:
        st["r5"] = round((closes[-1] / closes[-6] - 1) * 100, 2)

    # --- 상세용 히스토리 (최근 HIST_DAYS 거래일) : [d,o,h,l,c,v,fq,oq,iq]
    flow_by_date = {t["date"]: t for t in trend}
    rows = []
    for h in hist[-HIST_DAYS:]:
        d = h[0]
        t = flow_by_date.get(d) or {}
        c = h[4]
        if d == today and row.get("price"):
            c = row["price"]
        rows.append([d, h[1], h[2], h[3], c, h[5],
                     t.get("fp"), t.get("op"), t.get("ip")])
    return {"summary": st, "rows": rows}


# ---------------------------------------------------------------- aggregation
def load_prev() -> dict:
    p = os.path.join(DATA, "market.json")
    if not os.path.exists(p):
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def main():
    t0 = time.time()
    now = datetime.now(KST)
    prev = load_prev()
    os.makedirs(HDIR, exist_ok=True)

    print("[1/6] 전 종목 시세 수집…", flush=True)
    universe = fetch_universe()
    limit = int(os.environ.get("FETCH_LIMIT", "0") or 0)
    if limit:
        universe = universe[:limit]
    print(f"      {len(universe)} 종목 (코스피 {sum(1 for s in universe if s['market'] == 'KOSPI')} / "
          f"코스닥 {sum(1 for s in universe if s['market'] == 'KOSDAQ')})", flush=True)
    if not universe:
        print("ERROR: 종목 목록을 받지 못했습니다.", file=sys.stderr)
        return 2

    print("[2/6] 지수·수급·매크로 수집…", flush=True)
    indices = fetch_indices()
    prev_macro = {m.get("key"): m for m in (prev.get("macro") or [])}
    macro = fetch_macro(prev_macro)

    # --- PBR : 종목별 통합 API에서 병렬 수집. 실패 시 직전 수집값 유지.
    prev_pbr = {s.get("c"): s.get("pbr") for s in (prev.get("stocks") or []) if s.get("pbr")}
    print(f"[3/6] PBR 수집 ({len(universe)}종목, workers={PBR_WORKERS})…", flush=True)
    pbr_map: dict[str, float | None] = {}
    pbr_fail = 0
    t_pbr = time.time()
    with ThreadPoolExecutor(max_workers=PBR_WORKERS) as ex:
        for i, (code, v) in enumerate(ex.map(lambda r: (r["code"], fetch_pbr(r["code"])), universe), 1):
            if v is not None:
                pbr_map[code] = v
            else:
                pbr_fail += 1
                pbr_map[code] = prev_pbr.get(code)
            if i % 1000 == 0:
                print(f"      {i}/{len(universe)} ({time.time()-t_pbr:.0f}s)", flush=True)
    print(f"      PBR 확보 {sum(1 for v in pbr_map.values() if v)}종목 / 응답없음 {pbr_fail} "
          f"({time.time()-t_pbr:.0f}s)", flush=True)

    start = (now - timedelta(days=420)).strftime("%Y%m%d")
    end = now.strftime("%Y%m%d")
    print(f"[4/6] 종목별 일별 시세·수급 수집 (기간 {start}~{end}, workers={WORKERS})…", flush=True)

    results: dict[str, dict] = {}
    errors: list[str] = []

    def work(row):
        code = row["code"]
        try:
            hist = fetch_hist(code, start, end)
            trend = fetch_trend(code)
            return code, build_stock(row, hist, trend, pbr_map.get(code))
        except Exception as e:  # noqa: BLE001
            return code, {"__error": str(e)[:120]}

    done = 0
    t1 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for code, res in ex.map(work, universe):
            done += 1
            if "__error" in res:
                errors.append(code)
            else:
                results[code] = res
            if done % 250 == 0:
                print(f"      {Done(done, len(universe))} ({time.time()-t1:.0f}s)", flush=True)

    summaries = [r["summary"] for r in results.values()]
    if not summaries:
        print("ERROR: 종목 데이터를 하나도 수집하지 못했습니다.", file=sys.stderr)
        return 3
    # 부분 실패 보호: 직전 수집분 대비 60% 미만이면 기존 데이터를 덮어쓰지 않는다.
    prev_n = ((prev.get("counts") or {}).get("total") or 0)
    if prev_n and len(summaries) < prev_n * 0.6:
        print(f"ERROR: 수집 종목이 급감했습니다 ({len(summaries)} < 직전 {prev_n}). 기존 데이터 유지.",
              file=sys.stderr)
        return 4
    print(f"      완료 {len(summaries)}종목 / 실패 {len(errors)}", flush=True)

    # 시장 집계
    flow_dates = [s["fd"] for s in summaries if s.get("fd")]
    flow_date = max(flow_dates) if flow_dates else None
    up = sum(1 for s in summaries if (s.get("chp") or 0) > 0)
    down = sum(1 for s in summaries if (s.get("chp") or 0) < 0)
    flat = len(summaries) - up - down
    pbr_n = sum(1 for s in summaries if s.get("pbr"))
    low_pbr_n = sum(1 for s in summaries
                    if s.get("pbr") and s["pbr"] <= 1.0
                    and (s.get("b60") == 1 or s.get("b120") == 1
                         or (s.get("x60") is not None and s["x60"] <= 4)
                         or (s.get("x120") is not None and s["x120"] <= 4)))

    payload = {
        "generatedAt": now.isoformat(timespec="seconds"),
        "tradeDate": now.strftime("%Y-%m-%d"),
        "flowDate": flow_date,
        "counts": {
            "total": len(summaries),
            "kospi": sum(1 for s in summaries if s["m"] == "K"),
            "kosdaq": sum(1 for s in summaries if s["m"] == "Q"),
            "up": up, "down": down, "flat": flat,
            "errors": len(errors),
            "pbr": pbr_n, "pbrFail": pbr_fail, "lowPbr": low_pbr_n,
        },
        "indices": indices,
        "macro": macro,
        "stocks": summaries,
    }

    print("[5/6] data/market.json 기록…", flush=True)
    tmp = os.path.join(DATA, "market.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, os.path.join(DATA, "market.json"))

    # 상세 히스토리 shard
    print("[6/6] data/h/*.json shard 기록…", flush=True)
    shards: dict[str, dict] = {}
    for code, res in results.items():
        key = code[:2]
        shards.setdefault(key, {})[code] = res["rows"]
    for f_ in os.listdir(HDIR):
        if f_.endswith(".json") and f_[:-5] not in shards:
            os.remove(os.path.join(HDIR, f_))
    for key, obj in shards.items():
        with open(os.path.join(HDIR, f"{key}.json"), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"      shard {len(shards)}개", flush=True)

    meta = {
        "generatedAt": payload["generatedAt"],
        "flowDate": flow_date,
        "stocks": len(summaries),
        "errors": len(errors),
        "pbr": pbr_n,
        "lowPbr": low_pbr_n,
        "elapsedSec": round(time.time() - t0, 1),
    }
    with open(os.path.join(DATA, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    size = os.path.getsize(os.path.join(DATA, "market.json"))
    print(f"OK {len(summaries)}종목 / market.json {size/1024/1024:.2f}MB / {meta['elapsedSec']}s / "
          f"수급기준일 {flow_date} / PBR {pbr_n}종목 · 추세전환+PBR≤1 {low_pbr_n}종목", flush=True)
    if errors:
        print("실패 종목:", ",".join(errors[:20]), flush=True)
    return 0


def Done(a, b):  # noqa: N802 - 진행 로그
    return f"{a}/{b}"


if __name__ == "__main__":
    sys.exit(main())
