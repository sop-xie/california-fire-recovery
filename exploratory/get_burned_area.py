"""Download MODIS burned area (MCD64A1) for all of California from the ORNL API.

The API only serves boxes up to 200 x 200 km and 10 months per request, so the
state is covered by overlapping boxes. Raw responses are cached in
data/cache/mcd64a1/, so rerunning skips anything already downloaded.

Writes data/ca_burned_pixels.csv.gz: one row per burned 500 m pixel per month,
with its center lat/lon and the day of year it burned.
"""
import gzip
import json
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import requests
from matplotlib.path import Path as Polygon

from common import DATA, EAST, NORTH, SOUTH, WEST, california_rings

API = 'https://modis.ornl.gov/rst/api/v1/MCD64A1'
CACHE = DATA / 'cache' / 'mcd64a1'
EARTH_RADIUS = 6371007.181  # sphere used by the MODIS sinusoidal grid
HALF_KM = 100
HALF_EFFECTIVE_KM = 92  # the API returns 401 x 401 pixels, about 186 km, for 100 km
WORKERS = 3


def sinusoidal(lat, lon):
    """MODIS sinusoidal x, y in km for latitude and longitude in degrees."""
    y = np.radians(lat) * EARTH_RADIUS / 1000
    return np.radians(lon) * np.cos(np.radians(lat)) * EARTH_RADIUS / 1000, y


def california_points():
    """Sinusoidal x, y of a 0.02 degree grid of points inside California."""
    lat, lon = np.meshgrid(np.arange(SOUTH, NORTH, 0.02), np.arange(WEST, EAST, 0.02), indexing='ij')
    points = np.column_stack([lon.ravel(), lat.ravel()])
    inside = np.zeros(len(points), bool)
    for ring in california_rings():
        inside |= Polygon(ring).contains_points(points)
    return sinusoidal(points[inside, 1], points[inside, 0])


def cached_extents():
    """Sinusoidal extent (km) of every box already in the cache, one per box center."""
    extents = {}
    for path in sorted(CACHE.glob('*.json.gz')):
        center = tuple(path.name.split('_')[:2])
        if center in extents:
            continue
        r = json.loads(gzip.decompress(path.read_bytes()))
        size = float(r['cellsize']) / 1000
        x0, y0 = float(r['xllcorner']) / 1000, float(r['yllcorner']) / 1000
        extents[center] = (x0, y0, x0 + int(r['ncols']) * size, y0 + int(r['nrows']) * size)
    return extents


def covered(x, y, extents):
    hit = np.zeros(len(x), bool)
    for x0, y0, x1, y1 in extents:
        hit |= (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)
    return hit


def boxes_over_california():
    """Centers of boxes that cover every part of California not already cached.

    A box is square on the MODIS sinusoidal grid (401 pixels, about 186 km), which
    is slanted in latitude and longitude, so boxes are laid out on that grid.
    """
    x, y = california_points()
    todo = ~covered(x, y, cached_extents().values())
    step = 2 * HALF_EFFECTIVE_KM
    centers = []
    if todo.any():
        xs = np.arange(x[todo].min() + HALF_EFFECTIVE_KM, x[todo].max() + step, step)
        ys = np.arange(y[todo].min() + HALF_EFFECTIVE_KM, y[todo].max() + step, step)
        for yc in ys:
            for xc in xs:
                inside = todo & (np.abs(x - xc) <= HALF_EFFECTIVE_KM) & (np.abs(y - yc) <= HALF_EFFECTIVE_KM)
                if inside.any():
                    lat = np.degrees(yc * 1000 / EARTH_RADIUS)
                    lon = np.degrees(xc * 1000 / (EARTH_RADIUS * np.cos(np.radians(lat))))
                    centers.append((round(float(lat), 3), round(float(lon), 3)))
    return centers


def fetch(job):
    """Download one box and up to 10 months, or read it from the cache."""
    lat, lon, start, end = job
    path = CACHE / f'{lat}_{lon}_{start}_{end}.json.gz'
    if path.exists():
        return path
    params = dict(latitude=lat, longitude=lon, startDate=start, endDate=end,
                  kmAboveBelow=HALF_KM, kmLeftRight=HALF_KM, band='Burn_Date')
    for attempt in range(6):
        try:
            response = requests.get(f'{API}/subset', params=params, timeout=300,
                                    headers={'Accept': 'application/json'})
            if response.ok and isinstance(response.json().get('subset'), list):
                # Write then rename, so an interrupted run never leaves a half-written file.
                partial = path.with_suffix('.partial')
                partial.write_bytes(gzip.compress(response.content))
                partial.rename(path)
                return path
        except (requests.RequestException, ValueError):
            pass
        time.sleep(5 * 2 ** attempt)
    raise RuntimeError(f'ORNL failed for {job}')


def burned_pixels(path):
    """Return burned pixels in one cached response as (row, col, date, doy) tuples."""
    response = json.loads(gzip.decompress(path.read_bytes()))
    size = float(response['cellsize'])
    rows, cols = int(response['nrows']), int(response['ncols'])
    # Global pixel indices, so overlapping boxes can be de-duplicated.
    top = round(float(response['yllcorner']) / size) + rows
    left = round(float(response['xllcorner']) / size)
    found = []
    for month in response['subset']:
        data = np.array(month['data']).reshape(rows, cols)
        for r, c in zip(*np.nonzero(data > 0)):
            found.append((top - r, left + c, month['calendar_date'], int(data[r, c])))
    return found


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    started = time.time()
    centers = boxes_over_california()
    dates = requests.get(f'{API}/dates', params=dict(latitude=37, longitude=-119.5),
                         headers={'Accept': 'application/json'}, timeout=60).json()['dates']
    modis_dates = [d['modis_date'] for d in dates]
    chunks = [modis_dates[i:i + 10] for i in range(0, len(modis_dates), 10)]
    jobs = [(lat, lon, c[0], c[-1]) for lat, lon in centers for c in chunks]
    print(f'{len(centers)} boxes x {len(chunks)} date chunks = {len(jobs)} requests', flush=True)

    with ThreadPoolExecutor(WORKERS) as pool:
        for i, _path in enumerate(pool.map(fetch, jobs), 1):
            if i % 25 == 0 or i == len(jobs):
                print(f'  {i}/{len(jobs)} done, {(time.time() - started) / 60:.1f} min', flush=True)

    x, y = california_points()
    missing = (~covered(x, y, cached_extents().values())).mean()
    print(f'Share of California not covered by any box: {missing:.4%}', flush=True)
    unique = {}
    for path in sorted(CACHE.glob('*.json.gz')):
        for row, col, date, doy in burned_pixels(path):
            unique[(row, col, date)] = doy
    table = pd.DataFrame([(r, c, d, doy) for (r, c, d), doy in unique.items()],
                         columns=['row', 'col', 'date', 'doy'])
    size = 463.312716528
    y = (table.row - 0.5) * size
    x = (table.col + 0.5) * size
    table['lat'] = np.degrees(y / EARTH_RADIUS).round(5)
    table['lon'] = np.degrees(x / (EARTH_RADIUS * np.cos(y / EARTH_RADIUS))).round(5)
    inside = np.zeros(len(table), bool)
    points = table[['lon', 'lat']].to_numpy()
    for ring in california_rings():
        inside |= Polygon(ring).contains_points(points)
    table = table[inside].sort_values(['date', 'lat', 'lon'])
    table[['date', 'doy', 'lat', 'lon']].to_csv(DATA / 'ca_burned_pixels.csv.gz', index=False)
    print(f'Wrote {len(table):,} burned pixel-months in California '
          f'({(time.time() - started) / 60:.1f} min total)')


if __name__ == '__main__':
    main()
