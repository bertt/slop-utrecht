# Fetches the Utrecht municipal trees inside the build BBOX into tools/data/bomen_centrum.json.
# usage: uv run --with duckdb python tools/fetch-bomen.py
import json, os
import duckdb

URL = 'https://utrecht.blob.core.windows.net/catalog/bomenkaart_2026/park_en_straatbomen/park_en_straatbomen.parquet'
S, W, N, E = 52.08, 5.1, 52.1, 5.14  # must match BBOX in build-utrecht-geodata.mjs
OUT = os.path.join(os.path.dirname(__file__), 'data', 'bomen_centrum.json')

c = duckdb.connect()
c.execute('install httpfs; load httpfs; install spatial; load spatial')
rows = c.execute(f"""
  select round(st_x(geometry), 7), round(st_y(geometry), 7), Nederlands, Wetenschap, plantjaar
  from '{URL}'
  where st_x(geometry) between {W} and {E} and st_y(geometry) between {S} and {N}
""").fetchall()
trees = [{'lon': r[0], 'lat': r[1], 'name': r[2], 'latin': r[3], 'planted': r[4]} for r in rows]
with open(OUT, 'w', encoding='utf8') as f:
    json.dump({'source': URL, 'bbox': [S, W, N, E], 'trees': trees}, f, ensure_ascii=False, separators=(',', ':'))
print(f'{len(trees)} trees -> {OUT}')
