import base64
import math
import time
import zlib
from collections import defaultdict, deque
from datetime import datetime, timedelta

import cv2
import numpy as np
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sklearn.linear_model import LinearRegression

APP_VERSION = "2.4.1"
TOKEN = "dg-2026-operator-token"

# name: (state, river, [lat, lon], live_level_%, rise_per_day_%)
DAMS = {
    "Idukki":            ("Kerala",        "Periyar",     [9.845, 76.926],  94.2, 0.90),
    "Nagarjuna Sagar":   ("Telangana",     "Krishna",     [16.582, 79.306], 91.5, 0.80),
    "Srisailam":         ("Telangana",     "Krishna",     [16.083, 78.833], 93.0, 0.70),
    "Mettur":            ("Tamil Nadu",    "Kaveri",      [11.783, 77.750], 88.5, 0.60),
    "Mullaperiyar":      ("Kerala",        "Periyar",     [9.528, 77.150],  89.0, 0.30),
    "Hirakud":           ("Odisha",        "Mahanadi",    [21.500, 83.870], 86.5, 0.40),
    "Almatti":           ("Karnataka",     "Krishna",     [16.300, 75.880], 87.0, 0.50),
    "Tehri":             ("Uttarakhand",   "Bhagirathi",  [30.385, 78.490], 62.0, 0.10),
    "Bhakra Nangal":     ("Himachal",      "Sutlej",      [31.410, 76.436], 55.0, 0.20),
    "Sardar Sarovar":    ("Gujarat",       "Narmada",     [21.828, 73.750], 70.0, 0.20),
    "Krishna Raja Sagara":("Karnataka",    "Kaveri",      [12.420, 76.550], 75.0, 0.30),
    "Tungabhadra":       ("Karnataka",     "Tungabhadra", [15.270, 76.330], 68.0, 0.20),
    "Koyna":             ("Maharashtra",   "Koyna",       [17.350, 73.750], 58.0, 0.10),
    "Ukai":              ("Gujarat",       "Tapi",        [21.200, 73.600], 64.0, 0.20),
    "Kakrapar":          ("Gujarat",       "Tapi",        [21.230, 73.350], 63.0, 0.20),
    "Farakka":           ("West Bengal",   "Ganga",       [24.800, 87.900], 52.0, 0.10),
    "Maithon":           ("Jharkhand",     "Barakar",     [23.780, 86.900], 60.0, 0.15),
    "Panchet":           ("Jharkhand",     "Barakar",     [23.750, 86.970], 57.0, 0.10),
    "Bisalpur":          ("Rajasthan",     "Banas",       [25.980, 75.080], 45.0, 0.05),
    "Rana Pratap Sagar": ("Rajasthan",     "Chambal",     [24.920, 75.630], 49.0, 0.10),
    "Pulichintala":      ("Andhra Pradesh","Krishna",     [16.300, 79.900], 66.0, 0.25),
    "Sriram Sagar":      ("Telangana",     "Godavari",    [18.900, 78.100], 61.0, 0.20),
    "Salal":             ("J&K",           "Chenab",      [33.080, 74.780], 44.0, 0.05),
    "Chamera":           ("Himachal",      "Ravi",        [32.550, 76.030], 51.0, 0.10),
    "Pong":              ("Himachal",      "Beas",        [31.950, 75.930], 58.0, 0.15),
    "Pandoh":            ("Himachal",      "Beas",        [32.000, 77.070], 47.0, 0.10),
    "Ranjit Sagar":      ("Punjab",        "Ravi",        [32.050, 75.030], 53.0, 0.10),
    "Baglihar":          ("J&K",           "Chenab",      [33.060, 75.480], 46.0, 0.10),
    "Dul Hasti":         ("J&K",           "Chenab",      [33.300, 75.600], 42.0, 0.05),
    "Gandhi Sagar":      ("Madhya Pradesh","Chambal",     [24.780, 75.450], 56.0, 0.15),
    "Jawahar Sagar":     ("Rajasthan",     "Chambal",     [25.050, 75.630], 50.0, 0.10),
    "Jakham":            ("Rajasthan",     "Jakham",      [24.050, 74.350], 41.0, 0.05),
    "Bargi":             ("Madhya Pradesh","Narmada",     [23.030, 79.870], 63.0, 0.20),
    "Indirasagar":       ("Madhya Pradesh","Narmada",     [22.020, 76.530], 69.0, 0.20),
    "Omkareshwar":       ("Madhya Pradesh","Narmada",     [22.240, 76.150], 66.0, 0.20),
    "Bansagar":          ("Madhya Pradesh","Son",         [24.050, 81.850], 59.0, 0.15),
    "Dharoi":            ("Gujarat",       "Sabarmati",   [23.980, 72.680], 48.0, 0.10),
    "Kadana":            ("Gujarat",       "Mahi",        [22.980, 73.780], 54.0, 0.10),
    "Khadakwasna":       ("Maharashtra",   "Mula-Mutha",  [18.450, 73.750], 61.0, 0.15),
    "Jayakwadi":         ("Maharashtra",   "Godavari",    [19.480, 75.030], 57.0, 0.15),
    "Ujjani":            ("Maharashtra",   "Bhima",       [18.050, 75.100], 46.0, 0.10),
    "Radhanagari":       ("Maharashtra",   "Bhogawa",     [16.400, 74.000], 64.0, 0.15),
    "Gosekhurd":         ("Maharashtra",   "Wainganga",   [20.900, 79.630], 52.0, 0.10),
    "Nizam Sagar":       ("Telangana",     "Manjira",     [18.680, 77.680], 44.0, 0.10),
    "Somashila":         ("Andhra Pradesh","Penna",       [16.030, 79.050], 58.0, 0.15),
    "Narayanapura":      ("Karnataka",     "Krishna",     [16.450, 75.600], 62.0, 0.15),
    "Linganamakki":      ("Karnataka",     "Sharavathi",  [14.050, 75.050], 67.0, 0.15),
    "Bhadra":            ("Karnataka",     "Bhadra",      [13.750, 75.600], 71.0, 0.20),
    "Malaprabha":        ("Karnataka",     "Malaprabha",  [15.750, 75.350], 55.0, 0.10),
    "Kabini":            ("Karnataka",     "Kabini",      [11.980, 76.980], 69.0, 0.20),
    "Bhavanisagar":      ("Tamil Nadu",    "Bhavani",     [11.470, 77.220], 62.0, 0.15),
    "Amaravathi":        ("Tamil Nadu",    "Amaravathi",  [10.550, 77.550], 51.0, 0.10),
    "Aliyar":            ("Tamil Nadu",    "Aliyar",      [10.120, 76.930], 66.0, 0.15),
    "Vaigai":            ("Tamil Nadu",    "Vaigai",      [10.170, 78.120], 43.0, 0.05),
    "Parambikulam":      ("Kerala",        "Parambikulam",[10.350, 76.870], 72.0, 0.15),
    "Malampuzha":        ("Kerala",        "Malampuzha",  [10.850, 76.680], 68.0, 0.15),
    "Banasura Sagar":    ("Kerala",        "Kabini",      [11.680, 76.050], 74.0, 0.20),
    "Peechi":            ("Kerala",        "Manali",      [10.520, 76.420], 65.0, 0.15),
    "Indravati":         ("Odisha",        "Indravati",   [19.030, 82.050], 56.0, 0.15),
    "Balimela":          ("Odisha",        "Machkund",    [18.030, 81.780], 60.0, 0.15),
    "Kolab":             ("Odisha",        "Kolab",       [18.550, 82.050], 53.0, 0.10),
    "Tilaiya":           ("Jharkhand",     "Barakar",     [23.920, 86.680], 49.0, 0.10),
    "Konar":             ("Jharkhand",     "Konar",       [23.680, 86.050], 47.0, 0.10),
    "Massanjore":        ("Jharkhand",     "Mayurakshi",  [24.050, 87.250], 51.0, 0.10),
    "Rihand":            ("Uttar Pradesh", "Rihand",      [24.250, 82.700], 66.0, 0.20),
    "Matatila":          ("Uttar Pradesh", "Betwa",       [24.500, 78.930], 48.0, 0.10),
    "Rajghat":           ("Uttar Pradesh", "Betwa",       [24.950, 78.550], 42.0, 0.05),
    "Gangrel":           ("Chhattisgarh",  "Mahanadi",    [20.450, 81.050], 57.0, 0.15),
    "Umiam":             ("Meghalaya",     "Umiam",       [25.680, 91.920], 70.0, 0.20),
    "Kopili":            ("Assam",         "Kopili",      [25.000, 92.600], 54.0, 0.10),
    "Mithi":             ("Tripura",       "Mithi",       [23.800, 91.900], 46.0, 0.10),
    "Chimmini":          ("Kerala",        "Chimmini",    [10.650, 76.550], 63.0, 0.15),
}

# ---------- RIVER CASCADE GRAPH: (upstream, downstream, link/river label) ----------
CASCADE = [
    ("Salal", "Baglihar", "Chenab"),
    ("Baglihar", "Dul Hasti", "Chenab"),
    ("Chamera", "Ranjit Sagar", "Ravi"),
    ("Pandoh", "Pong", "Beas"),
    ("Gandhi Sagar", "Rana Pratap Sagar", "Chambal"),
    ("Rana Pratap Sagar", "Jawahar Sagar", "Chambal"),
    ("Indirasagar", "Omkareshwar", "Narmada"),
    ("Omkareshwar", "Sardar Sarovar", "Narmada"),
    ("Ukai", "Kakrapar", "Tapi"),
    ("Matatila", "Rajghat", "Betwa"),
    ("Tilaiya", "Maithon", "Barakar"),
    ("Maithon", "Panchet", "Barakar"),
    ("Kabini", "Krishna Raja Sagara", "Kabini-Kaveri"),
    ("Krishna Raja Sagara", "Mettur", "Kaveri"),
    ("Mullaperiyar", "Idukki", "Periyar"),
    ("Bhadra", "Tungabhadra", "Bhadra"),
    ("Tungabhadra", "Srisailam", "Tungabhadra-Krishna"),
    ("Malaprabha", "Almatti", "Malaprabha-Krishna"),
    ("Koyna", "Almatti", "Koyna-Krishna"),
    ("Almatti", "Narayanapura", "Krishna"),
    ("Narayanapura", "Srisailam", "Krishna"),
    ("Srisailam", "Nagarjuna Sagar", "Krishna"),
    ("Nagarjuna Sagar", "Pulichintala", "Krishna"),
    ("Parambikulam", "Aliyar", "Anaimalai tunnel"),
]
SURGE_BASE = 22.0     # % level surge injected into immediate downstream reservoir
HOP_COEFF = 0.65      # attenuation per hop
RAMP_SEC = 90.0       # flood wave ramp time

DOWN = defaultdict(list)
UP = defaultdict(list)
for _u, _d, _r in CASCADE:
    DOWN[_u].append((_d, _r))
    UP[_d].append((_u, _r))

BREACHED = {}   # name -> breach timestamp


def cascade_state():
    surge = {n: 0.0 for n in DAMS}
    sources = {n: [] for n in DAMS}
    active = []
    for b, ts in BREACHED.items():
        if b not in DAMS:
            continue
        ramp = min(1.0, (time.time() - ts) / RAMP_SEC)
        seen = {b}
        dq = deque([(b, ramp)])
        while dq:
            node, f = dq.popleft()
            for dn, _r in DOWN[node]:
                nf = f * HOP_COEFF
                if nf < 0.04:
                    continue
                surge[dn] += SURGE_BASE * nf
                if b not in sources[dn]:
                    sources[dn].append(b)
                active.append([node, dn])
                if dn not in seen:
                    seen.add(dn)
                    dq.append((dn, nf))
    return surge, sources, active


def _series(name: str) -> dict:
    state, river, coords, level, slope = DAMS[name]
    seed = zlib.crc32(name.encode())
    rng = np.random.default_rng(seed)
    phase = (seed % 628) / 100.0
    live = level + 0.5 * math.sin(time.time() / 38.2 + phase)   # slow live drift
    days = 60
    now = datetime.now()
    dates = [now - timedelta(days=i) for i in range(days, 0, -1)]
    hist = np.clip(live - slope * np.arange(days, 0, -1) + rng.normal(0, 0.6, days), 0, 100)
    model = LinearRegression().fit(np.arange(days).reshape(-1, 1), hist)
    fut_dates = [dates[-1] + timedelta(days=i) for i in range(1, 6)]
    fut = np.clip(model.predict(np.arange(days, days + 5).reshape(-1, 1)), 0, 105)
    peak = float(fut.max())
    status = "CRITICAL" if peak >= 95 else ("WARNING" if peak >= 88 else "SAFE")
    return {
        "state": state, "river": river, "coords": coords,
        "level": round(float(live), 1), "slope": round(float(slope), 2),
        "peak": round(peak, 1), "status": status,
        "history": [{"t": d.strftime("%Y-%m-%d"), "v": round(float(v), 2)} for d, v in zip(dates, hist)],
        "forecast": [{"t": d.strftime("%Y-%m-%d"), "v": round(float(v), 2)} for d, v in zip(fut_dates, fut)],
        "last_pass": (now - timedelta(hours=4)).strftime("%H:%M IST"),
    }


def _enrich(name, surge_map, src_map):
    s = _series(name)
    sg = surge_map.get(name, 0.0)
    level = round(s["level"] + sg, 1)
    peak = round(s["peak"] + sg, 1)
    status = "CRITICAL" if peak >= 95 else ("WARNING" if peak >= 88 else "SAFE")
    out = dict(s)
    out.update({"name": name, "level": level, "peak": peak, "status": status,
                "surge": round(sg, 1), "inflow_from": src_map.get(name, []),
                "breached": name in BREACHED})
    return out


app = FastAPI(title="AI Dam Guard API", version=APP_VERSION)


class LoginBody(BaseModel):
    username: str
    password: str


def auth(x_auth: str = Header(default=None)):
    if x_auth != TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/api/health")
def health():
    return {"status": "ok", "version": APP_VERSION, "time": datetime.now().isoformat()}


@app.post("/api/login")
def login(body: LoginBody):
    if body.username == "admin" and body.password == "damguard2026":
        return {"token": TOKEN, "operator": "admin", "role": "National Controller"}
    raise HTTPException(status_code=401, detail="Invalid credentials")


@app.get("/api/overview", dependencies=[Depends(auth)])
def overview():
    surge_map, src_map, active = cascade_state()
    dams = []
    for n in DAMS:
        e = _enrich(n, surge_map, src_map)
        dams.append({k: e[k] for k in ("name", "state", "river", "coords",
                                       "level", "peak", "status", "surge", "inflow_from", "breached")})
    crit = sum(1 for d in dams if d["status"] == "CRITICAL")
    warn = sum(1 for d in dams if d["status"] == "WARNING")
    safe = sum(1 for d in dams if d["status"] == "SAFE")
    avg = round(sum(d["level"] for d in dams) / len(dams), 1)
    alerts = [d for d in dams if d["status"] != "SAFE" or d["breached"]]
    alerts.sort(key=lambda d: d["peak"], reverse=True)
    return {"generated": datetime.now().isoformat(),
            "kpi": {"monitored": len(dams), "critical": crit, "warning": warn, "safe": safe, "avg": avg},
            "dams": dams, "alerts": alerts,
            "edges": [[u, d] for u, d, _ in CASCADE],
            "active_edges": active,
            "breached": sorted(BREACHED.keys())}


@app.get("/api/dam/{name}", dependencies=[Depends(auth)])
def dam_detail(name: str):
    if name not in DAMS:
        raise HTTPException(status_code=404, detail="Dam not in registry")
    surge_map, src_map, _ = cascade_state()
    e = _enrich(name, surge_map, src_map)
    proj = []
    seen = {name}
    dq = deque([(name, 1.0, 0)])
    while dq:
        node, f, hop = dq.popleft()
        for dn, r in DOWN[node]:
            nf = f * HOP_COEFF
            if nf < 0.04:
                continue
            base = _series(dn)["level"] + surge_map.get(dn, 0.0)
            add = 0.0 if name in BREACHED else SURGE_BASE * nf
            proj.append({"name": dn, "river": r, "hop": hop + 1,
                         "projected": round(min(100.0, base + add), 1)})
            if dn not in seen:
                seen.add(dn)
                dq.append((dn, nf, hop + 1))
    e["cascade"] = {"upstream": [{"name": u, "river": r} for u, r in UP[name]],
                    "downstream": proj}
    return e


@app.get("/api/report/{name}", dependencies=[Depends(auth)])
def dam_report(name: str):
    if name not in DAMS:
        raise HTTPException(status_code=404, detail="Dam not in registry")
    s = _series(name)
    rec = {"CRITICAL": "Immediate downstream alert & controlled gate release planning.",
           "WARNING": "Continuous monitoring, 6-hourly satellite revisit.",
           "SAFE": "Routine monitoring."}[s["status"]]
    text = (f"AI DAM GUARD — RISK REPORT\nDam: {name} ({s['state']}, {s['river']} River)\n"
            f"Generated: {datetime.now().strftime('%d-%m-%Y %H:%M')}\n"
            f"Current Live Level: {s['level']}% of FRL\n48h Forecast Peak: {s['peak']}% of FRL\n"
            f"24h Inflow Trend: +{s['slope']}%/day\nRisk Status: {s['status']}\nRecommendation: {rec}\n")
    return PlainTextResponse(text, headers={"Content-Disposition": f'attachment; filename="{name.replace(" ", "_")}_RiskReport.txt"'})


@app.post("/api/inspect", dependencies=[Depends(auth)])
async def inspect(file: UploadFile = File(...)):
    data = await file.read()
    gray = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise HTTPException(status_code=400, detail="Unreadable image")
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 50, 150)
    density = float((np.sum(edges > 0) / edges.size) * 100)
    cracked = bool(density > 4.5)
    _, enc = cv2.imencode(".png", edges)
    return {"cracked": cracked, "density": round(density, 2),
            "probability": round(min(99.4, 90 + density) if cracked else max(0.6, density), 1),
            "threshold": 4.5, "edge_map": base64.b64encode(enc).decode()}


@app.post("/api/sim/breach/{name}", dependencies=[Depends(auth)])
def sim_breach(name: str):
    if name not in DAMS:
        raise HTTPException(status_code=404, detail="Dam not in registry")
    BREACHED[name] = time.time()
    return {"ok": True, "breached": sorted(BREACHED.keys())}


@app.post("/api/sim/reset", dependencies=[Depends(auth)])
def sim_reset():
    BREACHED.clear()
    return {"ok": True}


app.mount("/", StaticFiles(directory="static", html=True), name="static")