"""每日抓取臺灣銀行牌告匯率，寫入 rates.json 與 rates-history.json（由 GitHub Actions 執行）"""
import csv, io, json, re, sys, urllib.request
from datetime import datetime, timedelta, timezone

URL = "https://rate.bot.com.tw/xrt/flcsv/0/day"
WANT = ["USD","HKD","GBP","AUD","CAD","SGD","CHF","JPY","ZAR","SEK","NZD","THB","PHP","IDR","EUR","KRW","VND","MYR","CNY"]
TPE = timezone(timedelta(hours=8))

def num(x):
    try:
        v = float(str(x).strip())
        return v if v > 0 else None
    except ValueError:
        return None

req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 (TripLedger rate updater)"})
with urllib.request.urlopen(req, timeout=30) as r:
    raw = r.read()
    cd = r.headers.get("Content-Disposition", "")

text = raw.decode("utf-8-sig", errors="replace")
rates = {}
for row in csv.reader(io.StringIO(text)):
    if not row or row[0].strip() not in WANT:
        continue
    cur = row[0].strip()
    cells = [c.strip() for c in row]
    try:
        b = cells.index("本行買入"); s = cells.index("本行賣出")
    except ValueError:
        b, s = 1, 11
    rates[cur] = [num(cells[b+1]), num(cells[s+1]), num(cells[b+2]), num(cells[s+2])]

ok = sum(1 for v in rates.values() if any(v))
if ok < 15:
    print(f"資料不完整（{ok} 個幣別），不更新"); sys.exit(0)

m = re.search(r"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})", cd)
t = datetime(*map(int, m.groups()), tzinfo=TPE) if m else datetime.now(TPE)
updated = t.strftime("%Y/%m/%d %H:%M")
day = t.strftime("%Y-%m-%d")

data = {"updatedAt": updated, "source": "https://rate.bot.com.tw/xrt?Lang=zh-TW", "rates": rates}
try:
    old = json.load(open("rates.json", encoding="utf-8"))
except Exception:
    old = {}
if old.get("updatedAt") == updated:
    print("牌告未變動"); sys.exit(0)

json.dump(data, open("rates.json", "w", encoding="utf-8"), ensure_ascii=False)
try:
    hist = json.load(open("rates-history.json", encoding="utf-8"))
except Exception:
    hist = {}
hist[day] = {"updatedAt": updated, "rates": rates}
hist = dict(sorted(hist.items())[-400:])
json.dump(hist, open("rates-history.json", "w", encoding="utf-8"), ensure_ascii=False)
print(f"已更新 {updated}（{ok} 個幣別）")
