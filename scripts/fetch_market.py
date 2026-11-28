#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
국내 주식 전 종목 터미널 - 데이터 수집기

수집 소스
  * m.stock.naver.com/api/stocks/marketValue/{KOSPI|KOSDAQ} : 전 종목 시세/시총 스냅샷
  * m.stock.naver.com/api/stock/{code}/trend             : 일별 외국인/기관/개인 순매수 (최근 60거래일)
  * m.stock.naver.com/api/stock/{code}/integration       : PER/PBR/EPS/BPS 등 투자지표 (PER·PBR용)
  * api.finance.naver.com/siseJson.naver                 : 일별 OHLCV + 외국인소진율 (최근 약 1년)
  * m.stock.naver.com/api/index/{KOSPI|KOSDAQ}/integration : 지수 + 투자자별 수급 + 상승/하락 종목수
  * query1.finance.yahoo.com/v8/finance/chart            : 환율/나스닥선물/SOX/SOXX·SOXL·SOXS

산출물
  data/market.json        목록용 (전 종목 요약 + 지수/매크로)
  data/h/{코드앞2자리}.json 종목 상세용 (최근 60거래일 OHLCV + 수급)
  data/y/{코드앞4자리}.json 차트용 일봉 OHLCV (최근 CHART_DAYS=380거래일, 완결된 봉만)
  data/meta.json          수집 상태
"""
from __future__ import annotations

import json
import math
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
YDIR = os.path.join(DATA, "y")
KST = timezone(timedelta(hours=9))

UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
UA_DESKTOP = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

WORKERS = int(os.environ.get("FETCH_WORKERS", "20"))
VAL_WORKERS = int(os.environ.get("VAL_WORKERS", os.environ.get("PBR_WORKERS", "24")))  # PER·PBR 수집 병렬도
HIST_DAYS = 60          # 상세 화면(수급 표)용 일별 데이터 보관 거래일 수
CHART_DAYS = 380        # 차트용 일봉 보관 거래일 수 (약 1년 6개월 · 1년 보기 + 120일선·일목균형표 선행 계산분)
CHART_LOOKBACK = 640    # 차트용 일봉을 받아올 과거 달력 일수 (약 430거래일)
FLOW_WINDOW = 30        # 연속 매수 계산에 쓰는 최대 거래일

# NXT(넥스트레이드) 프리·애프터마켓 표시 시간대 (KST, 분 단위)
NXT_PRE_FROM, NXT_PRE_TO = 8 * 60, 9 * 60            # 프리 08:00~08:50, 09:00 정규장 개장
NXT_AFTER_FROM = 15 * 60 + 40                        # 애프터 15:40~20:00 (마감 뒤에도 당일 마지막 시세 유지)

# 일목균형표 구름대(9·26·52·26) 돌파 탐지 — '구름대 돌파' 탭
CLOUD_TENKAN, CLOUD_KIJUN, CLOUD_SPANB = 9, 26, 52   # 전환선 9 · 기준선 26 · 선행스팬2 52
CLOUD_SHIFT = 25          # 오늘(idx)의 구름대는 25봉 전(ref=idx-25) 데이터의 선행스팬1·2
CLOUD_BREAK_BARS = 5      # 구름대 상단을 '최근 5거래일 내' 돌파한 것으로 볼 범위
CLOUD_VA_MIN = 3_000_000_000        # 거래대금 30억 원 이상
CLOUD_MC_MIN = 100_000_000_000      # 시가총액 1,000억 원 이상
CLOUD_GAP120_MAX, CLOUD_GAP60_MAX = 18.0, 15.0  # 상승 초기(과열 제외) 120일선·60일선 이격 상한 %


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


def fetch_valuation(code: str) -> tuple[float | None, float | None]:
    """(PBR, PER) 배. 네이버 종목 통합 API의 투자지표에서 한 번에 읽는다.

    결측/0 이하/N/A는 None. 값은 최근 결산 기준이라 매일 가격에 따라 조금씩
    움직인다. 적자 기업의 PER은 음수·N/A로 오므로 None으로 두어
    '저PER' 목록에 적자 종목이 섞이지 않게 한다.
    """
    try:
        d = json.loads(http_get(f"https://m.stock.naver.com/api/stock/{code}/integration"))
    except Exception:  # noqa: BLE001
        return None, None
    got: dict[str, float | None] = {"pbr": None, "per": None}
    for info in d.get("totalInfos") or []:
        k = info.get("code")
        if k not in got:
            continue
        s = str(info.get("value") or "").replace(",", "").replace("배", "").strip()
        if s in ("", "-", "N/A", "nan"):
            continue
        try:
            v = float(s)
        except ValueError:
            continue
        if v > 0:
            got[k] = round(v, 2)
    return got["pbr"], got["per"]


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


def _mid(highs: list[float], lows: list[float], a: int, b: int) -> float:
    """a~b봉 고가 최대·저가 최소의 중간값(일목균형표 계산용)."""
    return (max(highs[a:b + 1]) + min(lows[a:b + 1])) / 2


def cloud_at(highs: list[float], lows: list[float], i: int):
    """i번째 봉 자리의 구름대 (하단, 상단). 데이터가 모자라면 None.

    선행스팬은 25봉 앞으로 옮겨 그리므로 i번 봉의 구름대는 (i-25)봉에서 계산한
    전환선·기준선 평균(선행스팬1)과 52봉 중간값(선행스팬2)이다.
    """
    ref = i - CLOUD_SHIFT
    if ref < CLOUD_SPANB - 1 or i >= len(highs):
        return None
    tenkan = _mid(highs, lows, ref - (CLOUD_TENKAN - 1), ref)
    kijun = _mid(highs, lows, ref - (CLOUD_KIJUN - 1), ref)
    span_a = (tenkan + kijun) / 2
    span_b = _mid(highs, lows, ref - (CLOUD_SPANB - 1), ref)
    return (min(span_a, span_b), max(span_a, span_b))


def cloud_state(closes: list[float], highs: list[float], lows: list[float]) -> dict | None:
    """마지막 봉(오늘)의 구름대 위치 — {cs, cb, ct, ca 또는 cp}.

    cs: 2 = 최근 5거래일 내 구름대 상단 돌파 완료(초입)
        1 = 구름대 내부(하단~상단)에서 돌파 진행 중
        3 = 구름대 위(돌파한 지 5거래일 초과)
        0 = 구름대 아래
    cb·ct: 구름대 하단·상단, ca: 상단 돌파 뒤 지난 봉 수(state 2), cp: 구름대 내 위치 %(state 1)
    """
    idx = len(closes) - 1
    if idx < 0:
        return None
    cur = cloud_at(highs, lows, idx)
    if not cur:
        return None
    cbot, ctop = cur
    p = closes[idx]
    if p is None:
        return None
    out = {"cb": round(cbot, 1), "ct": round(ctop, 1)}
    if p < cbot:
        out["cs"] = 0
    elif p <= ctop:
        out["cs"] = 1
        out["cp"] = round((p - cbot) / (ctop - cbot) * 100, 1) if ctop > cbot else 100.0
    else:
        prev = cloud_at(highs, lows, idx - CLOUD_BREAK_BARS)
        fresh = bool(prev) and closes[idx - CLOUD_BREAK_BARS] <= prev[1] * 1.01
        if fresh:
            age = 0
            for k in range(1, CLOUD_BREAK_BARS + 1):
                ci = cloud_at(highs, lows, idx - k)
                if not ci or closes[idx - k] <= ci[1]:
                    break
                age = k
            out["cs"] = 2
            out["ca"] = age
        else:
            out["cs"] = 3
    return out


def cloud_score(st: dict) -> float | None:
    """구름대 돌파 추천 점수(cloudScore). 높을수록 위에 노출.

    구름대 상단 돌파 완료(500) > 구름대 내부 진행형(0) 순서를 크게 벌리고,
    60·120일선 동시 돌파 · 상승 초기(이격 작음) · 52주 고점 대비 여유 · 거래대금 ·
    시총 · 외국인/기관 순매수 · 흑자 PER · 과열 아닌 5일 흐름을 더한다.
    """
    cs = st.get("cs")
    if cs not in (1, 2, 3):
        return None
    p, m60, m120 = st.get("p"), st.get("ma60"), st.get("ma120")
    if not p or not m60 or not m120:
        return None
    up60 = (p - m60) / m60 * 100
    up120 = (p - m120) / m120 * 100
    sc = 500.0 if cs == 2 else 0.0
    if st.get("b60") == 1 and st.get("b120") == 1:
        sc += 80
    elif st.get("b60") == 1 or st.get("b120") == 1:
        sc += 45
    elif ((st.get("x60") is not None and st["x60"] <= CLOUD_BREAK_BARS - 1)
          or (st.get("x120") is not None and st["x120"] <= CLOUD_BREAK_BARS - 1)):
        sc += 20
    sc += max(0.0, CLOUD_GAP120_MAX - up120) * 2.5      # 120일선에 가까울수록 상승 초기
    sc += max(0.0, CLOUD_GAP60_MAX - up60) * 1.5
    hi = st.get("hi52")
    if hi:
        sc += max(0.0, min(45.0, (1 - p / hi) * 45)) * 0.18   # 52주 고점 대비 여유
    va = st.get("va") or 0
    if va > 0:
        sc += min(30.0, max(0.0, (math.log10(va) - math.log10(CLOUD_VA_MIN)) * 10))
    mc = st.get("mc") or 0
    if mc > 0:
        sc += min(10.0, max(0.0, (math.log10(mc) - math.log10(CLOUD_MC_MIN)) * 4))
    fv = st.get("fv") or 0
    if fv > 0:
        sc += 15 + min(15.0, math.log10(1 + fv / 1e8) * 8)
    if (st.get("iq") or 0) > 0:
        sc += 10
    per = st.get("per")
    if per and per > 0:
        sc += 10
        if per <= 20:
            sc += 5
    r5 = st.get("r5") or 0
    if r5 > 0:
        sc += min(12.0, r5) * 0.7
    if r5 > 25:
        sc -= (r5 - 25) * 0.8                            # 단기 과열 감점
    if cs == 2:
        sc += max(0, CLOUD_BREAK_BARS - (st.get("ca") or 0)) * 6   # 돌파 직후일수록 우선
    elif cs == 1:
        sc += (st.get("cp") or 0) / 100 * 20                        # 상단에 가까울수록 우선
    return round(sc, 1)


def cloud_tab_ok(s: dict) -> bool:
    """'구름대 돌파' 탭 기본 노출 조건(60·120선 위 · 상승 초기 · 품질 필터 · 돌파/진입)."""
    p, m60, m120 = s.get("p"), s.get("ma60"), s.get("ma120")
    if not p or not m60 or not m120:
        return False
    if p <= m60 or p <= m120:
        return False
    if (p - m120) / m120 * 100 > CLOUD_GAP120_MAX or (p - m60) / m60 * 100 > CLOUD_GAP60_MAX:
        return False
    if (s.get("va") or 0) < CLOUD_VA_MIN or (s.get("mc") or 0) < CLOUD_MC_MIN:
        return False
    return s.get("cs") in (1, 2)


def build_stock(row: dict, hist: list[list], trend: list[dict],
                val: tuple[float | None, float | None] = (None, None)) -> dict:
    """개별 종목 계산. hist는 오래된→최신 순. val=(pbr, per)."""
    pbr_val, per_val = val
    # --- 일별 흐름(최신순) 매핑
    trend = [t for t in trend if t.get("date")]
    trend.sort(key=lambda t: t["date"])            # 오래된→최신
    flow_dates = [t["date"] for t in trend]

    # --- 가격 시계열 (siseJson) : [date, o, h, l, c, v, fratio]
    hist = [h for h in hist if h and h[0]]
    hist.sort(key=lambda h: h[0])

    today = datetime.now(KST).strftime("%Y%m%d")
    bars = [h for h in hist if h[4] is not None]
    closes = [b[4] for b in bars]
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
    # PBR (주가순자산비율) · PER (주가수익비율). 유효값(>0)만 기록한다.
    # 적자(0 이하) PER은 저장하지 않아 저PER 목록에서 빠진다.
    if pbr_val is not None and pbr_val > 0:
        st["pbr"] = round(float(pbr_val), 2)
    if per_val is not None and per_val > 0:
        st["per"] = round(float(per_val), 2)
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

    # --- 일목균형표 구름대(9·26·52·26) 위치·돌파 상태와 추천 점수('구름대 돌파' 탭)
    if px and len(closes) >= CLOUD_SPANB + CLOUD_SHIFT:
        hh = [b[2] for b in bars]
        ll = [b[3] for b in bars]
        cc = list(closes)
        if not has_today:                     # 오늘 봉이 아직 없으면 종가로 이어 붙여 계산
            cc.append(px); hh.append(px); ll.append(px)
        cinfo = cloud_state(cc, hh, ll)
        if cinfo:
            st.update(cinfo)
            cs = cloud_score(st)
            if cs is not None:
                st["csc"] = cs

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

    # --- 차트용 일봉 (최근 CHART_DAYS 거래일, 완결된 봉만) : [YYMMDD, o, h, l, c, v]
    #     오늘 봉은 넣지 않는다. 장중 갱신(30분 간격)마다 40MB가 넘는 차트 파일이
    #     다시 커밋되는 것을 막고, 화면에서는 수급 shard의 당일 봉을 이어 붙여 그린다.
    chart = []
    for h in hist:
        d = h[0]
        if d == today or h[4] is None:
            continue
        chart.append([int(d[2:]), h[1], h[2], h[3], h[4], h[5]])
    chart = chart[-CHART_DAYS:]
    return {"summary": st, "rows": rows, "chart": chart}


# ---------------------------------------------------------------- aggregation
def write_chart_shards(results: dict[str, dict], universe: list[dict]) -> tuple[int, int]:
    """data/y/{코드앞4자리}.json 차트용 일봉 shard.

    * 내용이 같은 파일은 다시 쓰지 않는다(장중 재수집으로 커밋이 불어나는 것을 막는다).
    * 이번 수집에서 실패한 종목은 직전 파일의 이력을 그대로 둔다.
    * 상장폐지 등으로 유니버스에서 사라진 코드는 파일에서 지운다.
    """
    os.makedirs(YDIR, exist_ok=True)
    live = {r["code"] for r in universe}
    groups: dict[str, dict[str, list]] = {}
    for code, res in results.items():
        ch = res.get("chart")
        if ch:
            groups.setdefault(code[:4], {})[code] = ch

    written = kept = 0
    for key, obj in groups.items():
        path = os.path.join(YDIR, f"{key}.json")
        old_txt = None
        merged: dict[str, list] = {}
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    old_txt = f.read()
                merged = json.loads(old_txt)
            except Exception:  # noqa: BLE001
                merged, old_txt = {}, None
        merged = {c: v for c, v in merged.items() if c in live}
        merged.update(obj)
        body = json.dumps(merged, ensure_ascii=False, separators=(",", ":"))
        if body == old_txt:
            kept += 1
            continue
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(body)
        os.replace(tmp, path)
        written += 1

    # 유니버스에서 사라진 코드 묶음의 파일 정리
    prefix_live = {r["code"][:4] for r in universe}
    for f_ in os.listdir(YDIR):
        if f_.endswith(".json") and f_[:-5] not in prefix_live:
            os.remove(os.path.join(YDIR, f_))
    return written, kept


def load_prev() -> dict:
    p = os.path.join(DATA, "market.json")
    if not os.path.exists(p):
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def merge_cloud() -> int:
    """data/market.json + data/y/*.json 만으로 구름대 돌파 필드를 다시 계산해 병합한다(네트워크 없음).

    30분 자동 갱신(main)은 수집하면서 함께 계산하므로, 이 경로는 이미 받아 둔
    시세·차트 shard로 필드만 즉시 갱신할 때 쓴다: python3 scripts/fetch_market.py --merge-cloud
    """
    t0 = time.time()
    prev = load_prev()
    stocks = prev.get("stocks") or []
    if not stocks:
        print("ERROR: data/market.json 에 종목이 없습니다.", file=sys.stderr)
        return 2
    try:
        today = int(str(prev.get("tradeDate") or "").replace("-", "")[2:])
    except ValueError:
        today = 0

    by_prefix: dict[str, list[dict]] = {}
    for s in stocks:
        by_prefix.setdefault(str(s.get("c") or "")[:4], []).append(s)

    done = 0
    for pref, group in by_prefix.items():
        try:
            with open(os.path.join(YDIR, f"{pref}.json"), encoding="utf-8") as f:
                shard = json.load(f)
        except Exception:  # noqa: BLE001
            shard = {}
        for s in group:
            for k in ("cs", "cb", "ct", "ca", "cp", "csc"):
                s.pop(k, None)
            rows = shard.get(s.get("c")) or []
            if not rows or not s.get("p"):
                continue
            closes = [r[4] for r in rows]
            highs = [r[2] for r in rows]
            lows = [r[3] for r in rows]
            if int(rows[-1][0]) != today:   # 마지막 봉이 전일이면 오늘 종가를 이어 붙인다
                closes.append(s["p"])
                highs.append(s["p"])
                lows.append(s["p"])
            cinfo = cloud_state(closes, highs, lows)
            if not cinfo:
                continue
            s.update(cinfo)
            cs = cloud_score(s)
            if cs is not None:
                s["csc"] = cs
            done += 1

    cloud_n = sum(1 for s in stocks if cloud_tab_ok(s))
    cloud_break_n = sum(1 for s in stocks if cloud_tab_ok(s) and s.get("cs") == 2)
    counts = dict(prev.get("counts") or {})
    counts.update({"cloud": cloud_n, "cloudBreak": cloud_break_n,
                   "cloudInside": cloud_n - cloud_break_n})
    prev["counts"] = counts
    tmp = os.path.join(DATA, "market.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(prev, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, os.path.join(DATA, "market.json"))

    meta_path = os.path.join(DATA, "meta.json")
    try:
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:  # noqa: BLE001
        meta = {}
    meta.update({"cloud": cloud_n, "cloudBreak": cloud_break_n})
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    order = sorted((s for s in stocks if cloud_tab_ok(s)),
                   key=lambda s: -(s.get("csc") or 0))
    print(f"OK 구름대 계산 {done}종목 / 탭 대상 {cloud_n}종목 "
          f"(돌파 완료 {cloud_break_n} · 내부 {cloud_n - cloud_break_n}) / {time.time() - t0:.1f}s",
          flush=True)
    for i, s in enumerate(order[:10], 1):
        st = "돌파" if s.get("cs") == 2 else "진입"
        print(f"  {i:2d}. {s.get('csc'):>6} {s['n']} ({s['c']}) p={s['p']} "
              f"구름 {s.get('cb')}~{s.get('ct')} {st} PER={s.get('per')} "
              f"거래대금={(s.get('va') or 0) / 1e8:.0f}억", flush=True)
    return 0


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

    # --- PER·PBR : 종목별 통합 API에서 한 번에 병렬 수집. 실패 시 직전 수집값 유지.
    prev_val = {s.get("c"): (s.get("pbr"), s.get("per")) for s in (prev.get("stocks") or [])}
    print(f"[3/6] PER·PBR 수집 ({len(universe)}종목, workers={VAL_WORKERS})…", flush=True)
    val_map: dict[str, tuple[float | None, float | None]] = {}
    val_fail = 0
    t_val = time.time()
    with ThreadPoolExecutor(max_workers=VAL_WORKERS) as ex:
        for i, (code, v) in enumerate(ex.map(lambda r: (r["code"], fetch_valuation(r["code"])), universe), 1):
            pbr, per = v
            old_pbr, old_per = prev_val.get(code, (None, None))
            if pbr is None and per is None:
                val_fail += 1
                val_map[code] = (old_pbr, old_per)
            else:
                val_map[code] = (pbr if pbr is not None else old_pbr,
                                 per if per is not None else old_per)
            if i % 1000 == 0:
                print(f"      {i}/{len(universe)} ({time.time()-t_val:.0f}s)", flush=True)
    pbr_got = sum(1 for p, e in val_map.values() if p)
    per_got = sum(1 for p, e in val_map.values() if e)
    print(f"      PBR {pbr_got}종목 · PER {per_got}종목 / 응답없음 {val_fail} "
          f"({time.time()-t_val:.0f}s)", flush=True)

    start = (now - timedelta(days=CHART_LOOKBACK)).strftime("%Y%m%d")
    end = now.strftime("%Y%m%d")
    print(f"[4/6] 종목별 일별 시세·수급 수집 (기간 {start}~{end}, workers={WORKERS})…", flush=True)

    results: dict[str, dict] = {}
    errors: list[str] = []

    def work(row):
        code = row["code"]
        try:
            hist = fetch_hist(code, start, end)
            trend = fetch_trend(code)
            return code, build_stock(row, hist, trend, val_map.get(code) or (None, None))
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
    per_n = sum(1 for s in summaries if s.get("per"))

    def _trend_ok(s) -> bool:
        return (s.get("b60") == 1 or s.get("b120") == 1
                or (s.get("x60") is not None and s["x60"] <= 4)
                or (s.get("x120") is not None and s["x120"] <= 4))

    def _low_per(cap: float) -> int:
        return sum(1 for s in summaries
                   if s.get("per") and 0 < s["per"] <= cap and _trend_ok(s))

    low_per = {"le1": _low_per(1.0), "le1_5": _low_per(1.5), "le5": _low_per(5.0),
               "le10": _low_per(10.0), "le15": _low_per(15.0)}
    low_per_n = low_per["le1_5"]
    low_pbr_n = sum(1 for s in summaries
                    if s.get("pbr") and s["pbr"] <= 1.0 and _trend_ok(s))
    cloud_n = sum(1 for s in summaries if cloud_tab_ok(s))
    cloud_break_n = sum(1 for s in summaries if cloud_tab_ok(s) and s.get("cs") == 2)

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
            "pbr": pbr_n, "pbrFail": val_fail, "lowPbr": low_pbr_n,
            "per": per_n, "perFail": val_fail, "lowPer": low_per_n,
            "lowPerByCap": low_per,
            "cloud": cloud_n, "cloudBreak": cloud_break_n,
            "cloudInside": cloud_n - cloud_break_n,
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

    # 차트용 일봉 shard (변경분만 기록)
    y_written, y_kept = write_chart_shards(results, universe)
    y_rows = sum(len(res.get("chart") or []) for res in results.values())
    print(f"      차트 shard 갱신 {y_written}개 / 그대로 {y_kept}개 / 평균 "
          f"{y_rows / max(1, len(results)):.0f}봉", flush=True)

    meta = {
        "generatedAt": payload["generatedAt"],
        "flowDate": flow_date,
        "stocks": len(summaries),
        "errors": len(errors),
        "pbr": pbr_n,
        "lowPbr": low_pbr_n,
        "per": per_n,
        "lowPer": low_per_n,
        "lowPerByCap": low_per,
        "cloud": cloud_n,
        "cloudBreak": cloud_break_n,
        "chartDays": round(y_rows / max(1, len(results))),
        "elapsedSec": round(time.time() - t0, 1),
    }
    with open(os.path.join(DATA, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    size = os.path.getsize(os.path.join(DATA, "market.json"))
    print(f"OK {len(summaries)}종목 / market.json {size/1024/1024:.2f}MB / {meta['elapsedSec']}s / "
          f"수급기준일 {flow_date} / PER {per_n}종목 · 추세전환+PER≤1.5 {low_per_n}종목 "
          f"(추세전환 없이 PER≤1.5만: {sum(1 for s in summaries if s.get('per') and s['per'] <= 1.5)}종목) "
          f"/ PER≤1 {low_per['le1']} · ≤5 {low_per['le5']} · ≤10 {low_per['le10']} · ≤15 {low_per['le15']}",
          flush=True)
    if errors:
        print("실패 종목:", ",".join(errors[:20]), flush=True)
    return 0


def Done(a, b):  # noqa: N802 - 진행 로그
    return f"{a}/{b}"


if __name__ == "__main__":
    if "--merge-cloud" in sys.argv:
        sys.exit(merge_cloud())
    sys.exit(main())
