"""Download monthly MODIS NDVI for all of California from GIBS.

Each month is fetched once at about 1 km. August is kept at full detail for the
burn-scar analysis; every month is also averaged to about 5 km for the
statewide trend and seasonal cycle.

Writes:
    data/ca_ndvi_august_001.npz        August NDVI per year, 0.01 degree grid
    data/ca_ndvi_monthly_005.npz       every month, 0.05 degree grid
    data/ca_ndvi_statewide_monthly.csv date, statewide mean NDVI
"""
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import requests

from common import COLS, DATA, EAST, NORTH, ROWS, SOUTH, WEST, california_mask, cell_area_km2
from fetch_modis import (CAPABILITIES_URL, LAYERS, available_dates, coarsen,
                         fetch_image, load_colormap, pixels_to_values)

COARSE = 5  # 5 x 0.01 degree cells = 0.05 degrees


def main():
    layer = LAYERS['ndvi']
    lookup = load_colormap(layer['colormap'])
    capabilities = requests.get(CAPABILITIES_URL, timeout=120).content
    dates = available_dates(layer['id'], capabilities)
    mask = california_mask()
    coarse_mask = coarsen(mask.astype(float), COARSE) >= 0.5
    print(f'{len(dates)} months', flush=True)

    def fetch_month(date):
        rgba = fetch_image(layer['id'], date, (WEST, SOUTH, EAST, NORTH), COLS, ROWS)
        values = pixels_to_values(rgba, lookup)
        values[~mask] = np.nan
        return date, values

    august, monthly = {}, {}
    with ThreadPoolExecutor(4) as pool:
        for date, values in pool.map(fetch_month, dates):
            if date[5:7] == '08':
                august[int(date[:4])] = values.astype(np.float16)
            grid = coarsen(values, COARSE)
            grid[~coarse_mask] = np.nan
            monthly[date] = grid.astype(np.float16)
            print(f'  {date} mean {np.nanmean(values):.3f}', flush=True)

    years = sorted(august)
    np.savez_compressed(DATA / 'ca_ndvi_august_001.npz', years=np.array(years),
                        ndvi=np.stack([august[y] for y in years]))
    np.savez_compressed(DATA / 'ca_ndvi_monthly_005.npz', dates=np.array(dates),
                        ndvi=np.stack([monthly[d] for d in dates]))

    weights = cell_area_km2(0.05)
    rows = []
    for date in dates:
        grid = monthly[date].astype(float)
        valid = np.isfinite(grid)
        rows.append((date, round(float((grid[valid] * weights[valid]).sum() / weights[valid].sum()), 4),
                     round(float(valid.sum() / coarse_mask.sum()), 3)))
    pd.DataFrame(rows, columns=['date', 'ndvi', 'share_with_data']).to_csv(
        DATA / 'ca_ndvi_statewide_monthly.csv', index=False)
    print('done')


if __name__ == '__main__':
    main()
