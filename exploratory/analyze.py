"""Turn the downloaded burned area and NDVI into the tables behind the figures.

Run after get_burned_area.py and get_ndvi.py. Writes into data/:
    ca_burned_acres_by_year.csv       acres burned in California per year
    ca_last_burn_year_001.npz         most recent burn year per 1 km cell
    fires_summary.csv                 each named fire: dates, MODIS acres, cells used
    fire_recovery.csv                 burned minus never-burned NDVI, by years since fire
    ca_ndvi_change_001.npz            August NDVI change from normal, per year
    ca_scarred_area_by_fire_year.csv  land still below normal, by the year it burned

"Change from normal" is a cell's August NDVI minus its own pre-fire median August
NDVI, minus the same change averaged over nearby land that never burned. The
second step removes statewide wet and dry years, so what remains is the fire.
"""
import numpy as np
import pandas as pd
from scipy import ndimage

from common import (ACRES_PER_KM2, DATA, MODIS_PIXEL_KM2, NORTH, RES, WEST, california_mask,
                    cell_area_km2)

BURNED = 0.5        # share of a cell that must burn for the cell to count as burned
SCARRED = -0.05     # NDVI below normal that counts as still scarred
NEIGHBORHOOD = 51   # cells (about 50 km) used to measure the local wet/dry year effect
MIN_CONTROL = 30    # fewest never-burned cells needed to trust a neighborhood

# Named fires: seed point inside the fire, first and last burn month, published acres.
# Published acres are CAL FIRE totals as I recall them; they were not re-checked online.
FIRES = [
    ('Cedar', 32.98, -116.80, '2003-10', '2003-11', 273_246),
    ('Zaca', 34.75, -119.85, '2007-07', '2007-09', 240_207),
    ('Station', 34.30, -118.15, '2009-08', '2009-10', 160_557),
    ('Rim', 37.90, -119.95, '2013-08', '2013-10', 257_314),
    ('King', 38.85, -120.55, '2014-09', '2014-10', 97_717),
    ('Thomas', 34.45, -119.30, '2017-12', '2018-01', 281_893),
    ('Camp', 39.78, -121.55, '2018-11', '2018-11', 153_336),
    ('Creek', 37.25, -119.30, '2020-09', '2020-12', 379_895),
    ('Dixie', 40.10, -121.00, '2021-07', '2021-10', 963_309),
]


def to_cells(table):
    """Grid row and column of each pixel's center."""
    rows = ((NORTH - table.lat) / RES).astype(int).to_numpy()
    cols = ((table.lon - WEST) / RES).astype(int).to_numpy()
    return rows, cols


def burned_share(table, shape, area):
    """Share of each cell covered by the burned pixels in table."""
    rows, cols = to_cells(table)
    km2 = np.zeros(shape)
    np.add.at(km2, (rows, cols), MODIS_PIXEL_KM2)
    return np.minimum(km2 / area, 1.0)


def main():
    pixels = pd.read_csv(DATA / 'ca_burned_pixels.csv.gz', parse_dates=['date'])
    pixels['year'], pixels['month'] = pixels.date.dt.year, pixels.date.dt.month
    august = np.load(DATA / 'ca_ndvi_august_001.npz')
    ndvi_years, ndvi = list(august['years']), august['ndvi'].astype(np.float32)
    mask = california_mask()
    area = cell_area_km2()
    shape = mask.shape

    # Acres burned per calendar year (2000 and 2026 are partial years).
    acres = (pixels.groupby('year').size() * MODIS_PIXEL_KM2 * ACRES_PER_KM2).round()
    acres.rename('acres').to_frame().assign(
        months_covered=pixels.groupby('year').month.nunique()
    ).to_csv(DATA / 'ca_burned_acres_by_year.csv')

    # Share of each cell that burned, per calendar year.
    burn_years = sorted(pixels.year.unique())
    share = {year: burned_share(group, shape, area) for year, group in pixels.groupby('year')}
    ever = np.zeros(shape, bool)
    rows, cols = to_cells(pixels)
    ever[rows, cols] = True
    never_burned = mask & ~ndimage.binary_dilation(ever, iterations=1)

    last_burn = np.zeros(shape, np.int16)
    first_burn = np.full(shape, 9999, np.int16)
    for year in burn_years:
        hit = share[year] >= BURNED
        last_burn[hit] = year
        first_burn[hit & (first_burn == 9999)] = year
    np.savez_compressed(DATA / 'ca_last_burn_year_001.npz', last_burn=last_burn)

    # Each cell's normal August NDVI: the median before it first burned.
    # Cells that burned before 2003 have fewer than 3 clean years, so they use every year.
    years = np.array(ndvi_years)
    clean = years[:, None, None] < first_burn[None]
    clean_values = np.where(clean, ndvi, np.nan)
    enough = clean.sum(axis=0) >= 3
    normal = np.where(enough, np.nanmedian(clean_values, axis=0), np.nanmedian(ndvi, axis=0))

    change = np.full_like(ndvi, np.nan)
    for i in range(len(years)):
        anomaly = ndvi[i] - normal
        ok = never_burned & np.isfinite(anomaly)
        total = ndimage.uniform_filter(np.where(ok, anomaly, 0.0), NEIGHBORHOOD, mode='constant')
        count = ndimage.uniform_filter(ok.astype(float), NEIGHBORHOOD, mode='constant')
        local = np.where(count * NEIGHBORHOOD ** 2 >= MIN_CONTROL, total / np.maximum(count, 1e-9), np.nan)
        change[i] = np.where(mask, anomaly - local, np.nan)
    np.savez_compressed(DATA / 'ca_ndvi_change_001.npz', years=years,
                        change=change.astype(np.float16), normal=normal.astype(np.float16))

    # Scarred land each August, split by the calendar year the land last burned. Land is first
    # checked the August after its fire year: most fires burn July-November, so the fire year's
    # own August would catch only some of them, weeks after they burned (see writeup.html).
    rows_out = []
    for i, year in enumerate(years):
        latest = np.zeros(shape, np.int16)
        for burn_year in burn_years:
            if burn_year >= year:
                break
            latest[share[burn_year] >= BURNED] = burn_year
        for burn_year in np.unique(latest[latest > 0]):
            cells = (latest == burn_year) & np.isfinite(change[i])
            scarred = cells & (change[i] < SCARRED)
            rows_out.append((year, int(burn_year),
                             round(float(area[scarred].sum() * ACRES_PER_KM2)),
                             round(float(area[cells].sum() * ACRES_PER_KM2))))
    pd.DataFrame(rows_out, columns=['august', 'burn_year', 'scarred_acres', 'burned_acres']).to_csv(
        DATA / 'ca_scarred_area_by_fire_year.csv', index=False)

    # Recovery of named fires against nearby land that never burned.
    summary, recovery = [], []
    for name, lat, lon, start, end, published in FIRES:
        window = pixels[(pixels.date >= start) & (pixels.date <= end + '-28')]
        fire_share = burned_share(window, shape, area)
        labels, _count = ndimage.label(ndimage.binary_dilation(fire_share > 0, iterations=2),
                                       structure=np.ones((3, 3)))
        seed_r, seed_c = int((NORTH - lat) / RES), int((lon - WEST) / RES)
        near = labels[max(seed_r - 10, 0):seed_r + 11, max(seed_c - 10, 0):seed_c + 11]
        if not near.any():
            print(f'{name}: no burned pixels near the seed point')
            continue
        component = labels == np.bincount(near[near > 0]).argmax()
        w_rows, w_cols = to_cells(window)
        in_fire = component[w_rows, w_cols]
        modis_acres = in_fire.sum() * MODIS_PIXEL_KM2 * ACRES_PER_KM2
        fire_cells = component & (fire_share >= BURNED)

        start_year, start_month = int(start[:4]), int(start[5:7])
        end_year, end_month = int(end[:4]), int(end[5:7])
        # Exclude cells that also burned within 5 years before or any time after this fire.
        other = np.zeros(shape, bool)
        for year in burn_years:
            if start_year - 5 <= year < start_year or year > end_year:
                other |= share[year] >= BURNED
        focal = fire_cells & ~other

        pre = [y for y in years if start_year - 5 <= y < start_year or (y == start_year and start_month > 8)]
        first_post = end_year if end_month < 8 else end_year + 1
        pre_idx = [ndvi_years.index(y) for y in pre]
        pre_ndvi = np.nanmean(ndvi[pre_idx], axis=0)
        r0, r1 = np.nonzero(component.any(axis=1))[0][[0, -1]]
        c0, c1 = np.nonzero(component.any(axis=0))[0][[0, -1]]
        box = np.zeros(shape, bool)
        box[max(r0 - 50, 0):r1 + 51, max(c0 - 50, 0):c1 + 51] = True
        mean, spread = np.nanmean(pre_ndvi[focal]), np.nanstd(pre_ndvi[focal])
        similar = box & np.isfinite(pre_ndvi) & (np.abs(pre_ndvi - mean) <= spread)
        control = similar & never_burned
        loose_control = similar & ~component  # the earlier method, for comparison

        def gaps(ctrl):
            series = {y: float(np.nanmean(ndvi[i][focal]) - np.nanmean(ndvi[i][ctrl]))
                      for i, y in enumerate(years)}
            base = np.mean([series[y] for y in pre])
            return {y: v - base for y, v in series.items()}

        strict, loose = gaps(control), gaps(loose_control)
        start_time = start_year + (start_month - 0.5) / 12
        for y in years:
            if y >= first_post:
                recovery.append((name, start, int(y), round(y + 7.5 / 12 - start_time, 2),
                                 round(strict[y], 4), round(loose[y], 4)))
        summary.append((name, start, end, round(modis_acres), published,
                        int(focal.sum()), int((fire_cells & other).sum()), int(control.sum()),
                        round(float(mean), 3)))
        print(f'{name}: MODIS {modis_acres:,.0f} acres vs published {published:,}; '
              f'{focal.sum()} fire cells, {(fire_cells & other).sum()} dropped for other burns, '
              f'{control.sum()} never-burned comparison cells')

    pd.DataFrame(summary, columns=['fire', 'start', 'end', 'modis_acres', 'published_acres',
                                   'fire_cells', 'cells_dropped_reburn', 'control_cells',
                                   'pre_fire_ndvi']).to_csv(DATA / 'fires_summary.csv', index=False)
    pd.DataFrame(recovery, columns=['fire', 'start', 'august', 'years_since_fire', 'gap',
                                    'gap_loose_control']).to_csv(DATA / 'fire_recovery.csv', index=False)
    print('done')


if __name__ == '__main__':
    main()
